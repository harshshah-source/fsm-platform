# 126 — Dispatch permanently wedges a zone via orphaned SUGGESTED recommendations
Status: done (2026-07-16, TDD) — guard-not-throw on the recommender SUGGESTED create + finalized/null-run
orphan sweep (`recommender.service.ts` `clearFinalizedOrphans`) as the PRIMARY no-wedge guarantee;
post-rollback orphan cleanup + reason-annotated zone skip (`batch-assignment.service.ts`
`clearRunZoneOrphans`/`conflictingScheduleSeIds`; `dispatch-run.service.ts` stamps the reason on the
zone row). Decided semantics pinned by tests: finalized/null-run orphan → cleared for fresh re-eval;
still-RUNNING orphan → skipped, left intact. RED→GREEN spec `test/dispatch-zone-wedge.e2e-spec.ts`
(4 tests); dev-DB reconciliation found 0 orphans. Per-SE isolation is [[127]] (fast-follow, still open).
Type: AFK

> Source: pipeline risk audit 2026-07-16 (`docs/audits/pipeline-risk-audit-2026-07-16.md`, finding
> **NEW-1** — ranked #1). Triaged as the next session 2026-07-16: highest blast radius, unowned,
> trigger is the normal ZM-override workflow (not an edge case), no self-heal, and it **blocks safe
> `BUSINESS_SWEEPS_ENABLED` activation**.

> **Approach APPROVED 2026-07-16:** option (b) post-rollback cleanup **+** guard-not-throw on the
> recommender write (details below). Build is TDD, **RED first** — the failing test that reproduces
> the wedge on today's code is shown for review **before** the fix is written. Scheduler flags and
> `eligibility_mode` stay untouched. Per-SE isolation is split out to **#127** (fast-follow).

## Problem

A single rolled-back `dispatchForZone` transaction leaves orphaned `SUGGESTED` recommendation rows
that nothing ever cleans up, and the recommender then P2002s against them on **every** subsequent run
for that zone — the zone's auto-dispatch is dead until an operator manually deletes the rows. It is
the run-456 orphan failure *family* transplanted onto the dispatch write side, and the #100 dispatch
idempotency backstop is exactly what conceals it (the partial-unique fires as an unhandled throw, not
the intended clean skip).

## Evidence (verbatim from the audit, NEW-1)

- **Where:** `recommender/recommender.service.ts:204,277` (unguarded `recommendation.create`) +
  `scheduling/batch-assignment.service.ts:54-152` (zone-wide tx, P2002 swallowed to `skipped`) +
  **absence** of any cleanup (`recommendation` status is mutated in exactly one place —
  `batch-assignment.service.ts:136`, the consume step; grep-confirmed no delete/reset anywhere).
- **What happens:** `runForZone` writes one `SUGGESTED` row per assignable ticket via bare
  `.create` **outside** the dispatch transaction and **before** the advisory lock is taken. If
  `dispatchForZone`'s single zone-wide `$transaction` then rolls back, those `SUGGESTED` rows
  survive but their tickets are **never** flipped to `FORMALLY_ASSIGNED` (rollback), so they stay
  `OPEN/UNASSIGNED`. On the **next** run the recommender re-selects the same tickets
  (`recommender.service.ts:103-115`) and calls `.create({status:'SUGGESTED'})` again →
  **P2002** against `recommendations_one_suggested_per_ticket` (`migrations/20260708120000:11-12`).
  That P2002 is **not** caught in `runForZone`; it propagates to the per-zone `try/catch` in
  `dispatch-run.service.ts:112-117`, which records a zone error and moves on. Because the recommender
  processes tickets in canonical order and throws on the **first** ticket carrying a stale rec, the
  **whole zone** produces zero recommendations and zero dispatch — **every run, forever**, until an
  operator manually deletes the orphaned `SUGGESTED` rows. Nothing self-heals.
- **Trigger (any one):** (a) one SE already holds an `ACTIVE` `work_schedule` for that zone/day when
  dispatch runs → `dispatchForZone`'s `workSchedule.create` (`batch-assignment.service.ts:90`) hits
  `work_schedules_one_active_per_se_zone_day` (`migrations/20260708120000:19-20`) → whole-zone tx
  rollback → swallowed as `skipped{0,0,0}` (`:147-150`). The pre-existing schedule is exactly what a
  ZM manual override creates (`override.service.ts:440-450`, `source:'ZM_MANUAL'`, same
  `zoneId/dateFrom`). (b) any transient failure inside the long zone-wide tx (deadlock / statement
  cancel — no `statement_timeout`). (c) two concurrent dispatch runs of the same zone (NEW-3: manual
  trigger bypasses the in-flight guard).
- **Blast radius:** an entire zone's daily auto-dispatch is dead. On the 2026-07-13 live run East and
  UNZONED each dispatched 150–158 tickets/day; at real volume that is hundreds of field tickets left
  `OPEN/UNASSIGNED` per wedged zone per day. Also note the whole-zone tx is all-or-nothing: one SE's
  stale schedule blocks *every other SE's* dispatch in that zone.
- **Likelihood today:** LOW (dispatch is manual, single operator). **After activation:** MED — the
  05:00 cron and ZM overrides coexist daily; any zone-tx rollback is a one-way trip to the wedge.
- **Detectability:** MED — visible as a per-zone `error` in `dispatch_run_zones` + a log line
  (`dispatch-run.service.ts:114`), but not on `/api/integration/health`, and the root cause
  (orphaned recs) is non-obvious. No alert, no auto-heal.

### Supplementary evidence found while filing (for the fix design, not in the audit)

- `recommendations.run_id` exists and is indexed (`migrations/20260715090000_dispatch_run_ledger:78-79`)
  and is stamped on every recommendation the run writes (`recommender.service.ts:214,296`). So an
  orphan set is precisely addressable as `WHERE run_id = <run> AND status = 'SUGGESTED'`.
- `dispatch_decision_traces.recommendation_id` FK is **`ON DELETE CASCADE`** — the original
  `20260715090000_dispatch_run_ledger:96` RESTRICT was **superseded** by
  `20260715093000_dispatch_ledger_on_delete:26` (relaxed for the #104 retention purge). So deleting an
  orphaned recommendation **cascades its trace away** — cleanup is a single `recommendation.deleteMany`,
  no trace-first ordering. (`dispatch_decision_traces.run_id` stays RESTRICT, so a `dispatch_run` row
  still can't be deleted out from under a live trace — irrelevant to rec cleanup.) A trace row is
  written for every recommendation a run with a `runId` produces (`recommender.service.ts:356-358`).

## Fix approach (APPROVED 2026-07-16)

Option **(b) post-rollback cleanup + guard-not-throw** on the recommender write. Two layers with
distinct jobs — **both required**:

- **Guard (PRIMARY no-wedge guarantee).** The recommender's `SUGGESTED` create never throws on the
  `recommendations_one_suggested_per_ticket` unique. This alone prevents the permanent wedge **even in
  the crash-between-rollback-and-cleanup window** (where cleanup never ran). Reuses the #101
  `transitionOrConflict` posture (`common/transition-or-conflict.ts`).
- **Cleanup (LEDGER-HYGIENE layer).** On a rolled-back / lock-skipped `dispatchForZone`, delete this
  run's orphan `SUGGESTED` recs (+ their traces) so the common path never leaves an orphan at all and
  the ledger stays clean.

*(Option (a) — folding the recommender writes into the dispatch `$transaction` — was rejected: it
makes a long lock-holding tx (worsening the timeout-less-pool / lock-hold triggers this bug feeds on)
and couples two independently-callable services. (b) fixes the poisoning directly and cheaply.)*

### Guard-path semantics (DECIDED — not left implicit)

When a live orphan `SUGGESTED` already exists for a ticket the recommender is about to suggest, the
orphan is **cleared for fresh re-evaluation — never consumed as-is.** Rationale: a stale rec encodes a
*prior* run's SE availability / capacity / scoring; consuming it would dispatch an outdated decision
(assign to an SE who may now be unavailable or over capacity). Correctness over convenience.

Concretely, a pre-existing live `SUGGESTED` can only belong to:
- (i) a prior **finalized** `dispatch_run` (SUCCESS/PARTIAL/FAILED) — a genuine crash-window orphan →
  the run clears it (a plain rec delete; the trace cascades) and writes fresh under the **current** `run_id`; or
- (ii) a **still-RUNNING** concurrent run → the guard **skips** the create (that run owns the ticket;
  the per-zone advisory lock serializes the dispatch). Its recs are **never** deleted.

Distinguish the two by the owning `dispatch_run.status`. **Ledger consequence to handle:** in the rare
concurrent-run case, a dispatched ticket's schedule (current `run_id`) and its consumed
recommendation/trace (the other run's `run_id`) can differ — the transparency joins must tolerate a
schedule/rec `run_id` mismatch (they already resolve per-entity; **verify, don't assume**).

## Acceptance criteria (APPROVED)

- [ ] **RED first** — a regression test reproduces the wedge on **today's** code: a pre-existing
      `ACTIVE` `ZM_MANUAL` `work_schedule` for an SE in zone Z / today (as `override.ensureSchedule`
      produces, `override.service.ts:440-450`) → one dispatch of Z rolls that zone's tx back (asserts:
      0 schedules, tickets still `OPEN/UNASSIGNED`, orphan `SUGGESTED` recs present) → the **next**
      `runForZone(Z)` throws P2002 and Z dispatches zero. **Show the failing output before building.**
- [ ] **Guard (no-wedge):** with an orphan `SUGGESTED` present and cleanup deliberately NOT run, the
      next recommender run for Z does **not** throw — it clears the finalized-run orphan and
      re-evaluates fresh (and skips a still-RUNNING run's rec). Zone self-heals, no manual step. Tested.
- [ ] **Cleanup (hygiene):** a rolled-back / lock-skipped `dispatchForZone` deletes its own run's
      orphan `SUGGESTED` recs keyed `(run_id = thisRun, zoneId, status='SUGGESTED')`; their trace rows
      cascade away (`dispatch_decision_traces.recommendation_id` is `ON DELETE CASCADE`,
      `migrations/20260715093000:26`). After the common-path rollback, **zero** orphans remain.
- [ ] **Detectability — never a silent skip:** a whole-zone skip is recorded in `dispatch_run_zones`
      with a machine-readable **reason** identifying the conflict (e.g. the conflicting SE's existing
      schedule), never a bare `skipped{0,0,0}` with `error:null`. The cleanup path likewise records the
      orphan-deleted **count + reason** on the zone row. (Existing `error` field or a new column —
      implementer's choice, but the reason must be queryable.)
- [ ] **Rollback-cause-agnostic:** a zone tx that rolls back for a non-P2002 reason (forced transient
      error) is covered by the same no-orphan guarantee — the fix keys on the rollback, not the code.
- [ ] **Idempotent recovery:** after cleanup, a re-run for Z dispatches normally (once the conflicting
      schedule is gone or the SE is skipped per #127) — the orphan no longer blocks.
- [ ] **Concurrency:** two same-zone dispatch runs cannot produce a permanent orphan (covers the
      NEW-3 overlap path to the extent it can wedge).
- [ ] **Dev-DB reconciliation:** query the dev DB for orphaned `SUGGESTED` rows left by past rollbacks;
      if any exist, report the count and clear them **through the new cleanup path (audited)** — never
      raw SQL. Record the count + outcome in the session log.
- [ ] Selection / scoring / ordering unchanged (observe-only invariants intact); existing
      dispatch / recommender / transparency suites green; `#99` route sweep green; tsc + build clean both apps.

## Out of scope (filed separately)

- **Per-SE dispatch isolation → [#127](./127-dispatch-per-se-isolation.md).** `dispatchForZone` is one
  all-or-nothing zone-wide tx, so one SE's conflict fails the WHOLE zone. After this issue that is a
  clean, reason-annotated skip (no wedge) — but the zone still dispatches **zero** that day. Making one
  SE's conflict skip only that SE is #127, a fast-follow (ZM overrides are daily-normal).

## Blocked by
None. Touches `scheduling/batch-assignment.service.ts`, `scheduling/dispatch-run.service.ts`, and/or
`recommender/recommender.service.ts`. Related: NEW-2 / NEW-3 (audit) are separate sessions.
