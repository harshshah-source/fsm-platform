# Pattern-Tracing Audit — Scheduler + Assignment Stack

**Date:** 2026-07-21
**Branch:** `feat/autoplant-integration`
**Type:** Focused pattern-tracing (NOT a general review). READ-ONLY. No code changed, no issues filed.
**Mandate:** find every *remaining* instance of five specific patterns seeded by the July-19 damage
class ("code trusts a derived flag / cached state / lock it no longer holds without re-consulting
source-of-truth"). Reconcile against the two prior audits; do not re-surface known findings; report
only NEW instances; and state VERIFIED-CLEAN paths explicitly (a checked-clean path is data).

**Prior record reconciled against (read in full):**
- `docs/audits/ticket-and-assignment-review-2026-07-21.md` — NEW-A1, NEW-A2, NEW-C1, NEW-C2 + V1–V12.
- `docs/audits/pipeline-risk-audit-2026-07-16.md` — NEW-1…NEW-7, R1…R10.
- `.scratch/fsm-platform-v1/issues/126-*` (dispatch zone-wedge, resolved) and `130-*` (stale-code guard).

---

## 0. Note on the finding IDs in the tasking prompt

The prompt cites three known findings as `NEW-C1 / NEW-A6 / NEW-A2` with one-line descriptions
("eligibility trusts device_state not plant_deactivations" / "recommender trusts open-ticket not
is_departed" / "dispatch trusts advisory-lock after release") and says the ticket-and-assignment audit
"surfaced 15 findings." The **filed** audit (`ticket-and-assignment-review-2026-07-21.md`) surfaced
**4** new findings (NEW-A1, NEW-A2, NEW-C1, NEW-C2) and `NEW-A6` does not exist anywhere in the repo.
Two of the prompt's descriptions are, per that audit, already **VERIFIED CLEAN**:
- "recommender trusts open-ticket, not `is_departed`" → **V2**: `recommender.service.ts:113` re-reads
  the departure **ledger** (`device: { departures: { none: { restoredAt: null } } }`), not the flag.
- "ticket-creation / eligibility trusts a derived flag" → **V1/V8**: `ticket-creation.service.ts:46,48`
  re-read the departure ledger **and** the deactivation ledger at the write moment.

The prompt's IDs are therefore treated as *pattern seeds* (they correctly describe the pattern family),
not as literal open findings. The hunt below proceeds on the pattern definitions themselves.

---

## 1. Reconciliation — which known finding already covers which pattern (no double-counting)

| Pattern | Already covered by | Status |
|---|---|---|
| **P1** derived-flag trust — ticket creation | NEW-1/#130 (fixed), V1/V8 | closed / clean — not re-hunted on this path |
| **P1** derived-flag trust — recommender troubleshoot selection | V2/V8 | clean — not re-hunted |
| **P1** derived-flag trust — departure absence guard (ratio) | **NEW-C1** | known-open — not re-surfaced |
| **P2** orphan-state — dispatch SUGGESTED recs | **NEW-1** (resolved #126), V6 | closed — not re-surfaced |
| **P2** orphan-state — departure reconcile | V9 (atomic) | clean |
| **P3** lock-scope — dispatch consume window | V4 (`pg_try_advisory_xact_lock` inside the tx) | clean |
| **P3** capacity check scope (per-zone-run) | **NEW-A1** (now mitigated in code, see §4-V) | known → verified fixed this pass |
| **P4** cron reads config at load | env-only config (§4-V) | clean today / forward-flagged |
| **P4** two crons same minute + shared resource | **NEW-6** (`:00` fan-out) | known-open — not re-surfaced |
| **P4** in-flight guard resets on restart / multi-instance | **NEW-5** | known-open — not re-surfaced |
| **P4** silent-failure inside a @Cron body | **NEW-4** (no sweep ledger/health) | known-open — not re-surfaced |
| **P4** reaper-vs-heartbeat | **NEW-2** | known-open — not re-surfaced |
| **P5** two dispatch runs, same zone | **NEW-3** + NEW-1 | known-open — not re-surfaced |
| **P1** null-SLA-bucket silent drop | **NEW-A2** | known-open — not re-surfaced |
| **P1/P2** deactivation TOCTOU in ticket-creation | **NEW-C2** | known-open — not re-surfaced |

**Consequence:** Patterns 2–5 are almost entirely *already owned* by the two prior audits. The only
un-audited surface with real yield is **Pattern 1 on the paths both prior audits excluded** — the
coverage materialized view and the cross-zone / field-loop services (`ticket-and-assignment-review`
§5 excluded field-loop services; `pipeline-risk-audit` excluded everything but ingestion/schedulers/
dispatch). The three NEW findings below all live there.

---

## 2. New findings

Per finding: id · pattern · where (both sides of the trust boundary) · what happens · trigger ·
shared-root · blast · likelihood-post-activation · verdict · suggested-fix-family.

### NEW-A3 — Recommender's FLOATING candidate leg trusts a materialized view refreshed on only one of its input-change paths *(Pattern 1; headline)*

- **Pattern:** 1 (derived-artifact trust without source re-check at the write moment) — with a Pattern-2 leg.
- **Where (trust side):** `recommender/candidate-selection.service.ts:35-38` reads FLOATING candidates
  straight from the `plant_eligible_floating_se` **materialized view**; consumed at dispatch/selection
  time by `recommender.service.ts:182` (`orderedCandidatesForPlant`). The DEDICATED/MULTI_PLANT legs
  read the `se_coverage` **table** live (`candidate-selection.service.ts:24-33`) — source of truth,
  clean. Only the FLOATING leg trusts the derived MV.
- **Where (source side / refresh):** the MV is a function of `engineer_territory_coverage` ∪ polygon,
  the **plant** set, and (per its doc) SE `coverage_type`. Its **only** refreshers are
  `org/se-territory.service.ts:91` and `:113` (`addTerritory` / `removeTerritory`) — a **best-effort,
  post-commit** `this.eligibility.refresh()` (`plant-eligible-floating-se.service.ts:18-24`, run
  *outside* the audit tx because `REFRESH … CONCURRENTLY` cannot run in a transaction). A
  repo-wide grep for `.refresh(` / `REFRESH MATERIALIZED` confirms **no other caller** and **no
  scheduled refresh** (only the seed, `org/org-seed.ts:240`). The docstring's "(later) nightly" refresh
  **does not exist yet.**
- **What happens (three legs):**
  1. **Non-territory input changes never refresh (the core P1 leak).** A **new plant**, or a plant whose
     district/region/state/location changes, alters the MV's plant→SE mapping — but plant CRUD calls no
     refresh. Until the *next* unrelated territory edit happens to rebuild the MV, a new plant has **zero
     FLOATING candidates**; its tickets fall to `NO_COVERAGE` UNASSIGNABLE even when a floating SE's
     territory plainly covers it. Symmetrically, an SE `coverage_type` flip (engineer-admin) or a
     district→region re-parent changes eligibility with no refresh.
  2. **Post-commit refresh is orphan-prone (P2 leg).** The territory row commits inside `withAudit`
     (`se-territory.service.ts:78-88`); `refresh()` runs after (`:91`/`:113`). A crash, a cancelled
     request, or a `refresh()` throw (both the CONCURRENTLY path and its plain fallback can fail on lock
     timeout) between commit and refresh leaves the territory change **durable** and the MV **stale**,
     with no retry, ledger, or reconcile — permanently, until another edit succeeds a refresh.
  3. **No periodic backstop (P4/defense-in-depth leg).** Because there is no nightly `REFRESH` cron,
     nothing heals leg 1 or leg 2. The MV drifts monotonically from source until a territory edit.
- **Trigger:** any change to floating eligibility that does not go through
  `SeTerritoryService.add/removeTerritory` — plant creation/relocation (routine onboarding), SE
  coverage-type change, hierarchy re-parent; or a crash in the post-commit refresh window.
- **Shared root-cause:** same family as **NEW-C1** and the July-19 seed — a write path reasons over a
  derived artifact (`is_departed` / absence-ratio / this MV) that is not re-consulted against, or
  reconciled with, its source at the moment it is trusted.
- **Blast radius:** for affected plants the FLOATING coverage tier is silently wrong at dispatch —
  either missing (new/relocated plants → spurious `NO_COVERAGE`, real field work never dispatched) or
  stale (a floating SE dispatched to a plant they no longer cover — a wasted truck roll, the #128 class).
  Bounded to plants whose eligibility changed since the last refresh; unbounded in time because nothing
  refreshes on its own.
- **Likelihood post-activation:** MED. Plant onboarding and territory tuning are normal ops; the daily
  dispatch cron consumes the MV every morning; the only thing masking it today is that dispatch is off.
- **Verdict:** **CONFIRMED** for legs 1 (plant CRUD) and 2 (post-commit orphan) against the cited lines.
  Leg-1's SE-`coverage_type` sub-case is **PLAUSIBLE** pending the MV DDL (not read this pass — flagged
  in §5): it depends on whether the view re-filters `coverage_type` at read time.
- **Suggested-fix-family:** *same as NEW-C1* (re-consult / reconcile source) **plus** a scheduled
  `REFRESH MATERIALIZED VIEW CONCURRENTLY` (a business-sweep tick — closes legs 2+3 as defense in depth)
  **plus** a refresh call on every MV-input mutation (plant create/relocate, SE coverage-type change),
  routed through one `refreshEligibility()` seam so no writer is forgotten.

### NEW-A4 — Cross-zone `approve` is a two-phase non-atomic commit; a crash strands the escalation PENDING while the ticket is already assigned, and retry can never heal it *(Pattern 2)*

- **Pattern:** 2 (a related write outside the transaction that carries the primary write).
- **Where:** `cross-zone/cross-zone-escalation.service.ts:158` calls `override.assignTicket(...)` (its
  own atomic tx — `override.service.ts:262-297`, commits the Formal Assignment) and **then**, as a
  **separate** statement, `:162-174` updates the `crossZoneEscalation` row to `APPROVED` with the
  schedule/batch ids. No enclosing transaction spans the two.
- **What happens:** if the process dies (or the DB drops the connection) after `assignTicket` commits
  but before the `:162` update, the ticket is durably `FORMALLY_ASSIGNED` with a schedule + batch, while
  the escalation is still `PENDING`. On retry, `assignTicket` re-reads the ticket, sees
  `assignmentState === 'FORMALLY_ASSIGNED'` and returns `ALREADY_ASSIGNED` (`override.service.ts:257`);
  `approve` maps that to `{ result: 'ALREADY_ASSIGNED' }` at `:159` and returns **without** updating the
  escalation. The escalation is now **permanently stuck PENDING** — it shows in the CSM queue
  (`listForScope`), the CSM keeps "approving," and every attempt short-circuits on `ALREADY_ASSIGNED`.
- **Trigger:** a crash / connection drop / statement-cancel in the millisecond window between the two
  writes (no `statement_timeout` — pipeline R2 amplifies it), on the cross-zone approve path.
- **Shared root-cause:** **NEW-1 / #126** family — the primary write and its bookkeeping write are not
  in one transaction, so a partial completion leaves durable inconsistent state a later run trips on.
- **Blast radius:** one escalation per occurrence, permanently un-closable through the UI; the ticket
  itself is correctly assigned, so field work is fine — the damage is a stuck decision record + CSM
  confusion. Low volume, but self-perpetuating (never self-heals).
- **Likelihood post-activation:** LOW–MED (needs a crash in a narrow window, but the window recurs on
  every approve and the outcome is durable).
- **Verdict:** **CONFIRMED** against the cited lines.
- **Suggested-fix-family:** *same as NEW-1* — make retry reconcile: when `assignTicket` returns
  `ALREADY_ASSIGNED`, have `approve` still transition the escalation to `APPROVED` if the existing
  assignment's SE/target match (idempotent completion); or fold the escalation update into the same
  transaction that assigns (pass the escalation write into `assignTicket`'s tx via a callback).

### NEW-A5 — Cross-zone auto-escalation sweep does three non-transactional writes with no per-ticket guard; a partial failure orphans the notification and the ticket is excluded from re-sweep *(Pattern 2)*

- **Pattern:** 2 (related writes — escalation row, audit row, notification — not atomic).
- **Where:** `cross-zone/cross-zone-escalation.service.ts:95-111` — per qualifying ticket:
  `crossZoneEscalation.create` (`:95`) → `auditEscalation` (`:106`) → `notifyCrossZoneQueue` (`:110`),
  three independent awaits, **no `$transaction`, no per-ticket try/catch**. Idempotency is the WHERE
  clause `crossZoneEscalations: { none: {} }` (`:79`) — "ticket has no escalation at all."
- **What happens:** if `notifyCrossZoneQueue` (or the audit write) throws for ticket *N*, the exception
  propagates out of `sweepAutoEscalations` and is swallowed by the scheduler's `runGuarded` catch
  (`business-sweep-scheduler.service.ts:135-137`, i.e. **NEW-4**). Ticket *N* already has its escalation
  row committed (`:95`) but **no notification**. On the next sweep the `none: {}` filter now **excludes**
  *N* (it has an escalation), so the notification is **never** retried — the CSM's notification shade
  silently misses a Platinum cross-zone escalation. (The queue *read* still shows it, so it is not fully
  invisible — which is why this ranks below NEW-A4.)
- **Trigger:** any throw from the notification or audit write mid-sweep (a bad recipient row, an FK
  hiccup, a downstream notifications bug) after `BUSINESS_SWEEPS_ENABLED=true`.
- **Shared root-cause:** **NEW-1** family (non-atomic related writes) compounded by **NEW-4**
  (the swallowed sweep error hides it).
- **Blast radius:** one un-notified escalation per failure; bounded, and softened by the queue read.
- **Likelihood post-activation:** LOW.
- **Verdict:** **CONFIRMED** against the cited lines.
- **Suggested-fix-family:** wrap `create` + `auditEscalation` in one tx; make `notify` explicitly
  best-effort *and* retryable (drive notification off a durable outbox / re-scan on missing-notification
  rather than off `none: {}`), so a notification failure cannot be masked by the idempotency filter.

---

## 3. Ranked (blast × likelihood-post-activation × inverse-detectability)

1. **NEW-A3** — MV staleness. Highest product: MED likelihood (routine plant/territory ops + a daily
   consumer), real bilateral blast (spurious `NO_COVERAGE` *and* wrong-SE dispatch), and LOW
   detectability (a plant simply "has no floating coverage" reads as an Ops gap, not a stale view). It
   is the July-19 derived-trust pattern re-instantiated on the coverage MV, with no periodic backstop.
2. **NEW-A4** — cross-zone approve orphan. Durable, self-perpetuating, operator-visible-but-unfixable;
   low volume keeps it below A3.
3. **NEW-A5** — cross-zone notify orphan. Lowest blast (queue read still shows the row) and needs a
   sweep-time throw to trigger.

---

## 4. VERIFIED CLEAN (checked this pass, found to correctly re-consult source / hold the lock / be atomic)

- **V-P1a — Recommender troubleshoot selection re-reads both ledgers.** `recommender.service.ts:109`
  (deactivations) + `:113` (departures) gate on the side tables, not the derived flags. (Confirms prior
  V2/V8 still hold at this tree.)
- **V-P1b — Recommender operating-mode is computed LIVE, not from the history snapshot.**
  `soft-inactive-count.service.ts:57-66` (`modeForZone`) counts `device_states` live at run time;
  `soft_inactive_count_history` is written by the twice-daily `recompute` (`:108-132`) for reporting
  only and is **never read** by the switch. A stale/never-run history cube cannot skew dispatch mode.
  (The mode does read `device_states.is_inactive`, a derived flag — but mode is a *scoring/priority*
  choice, not one of Pattern-1's enumerated safety gates, and every consumer uses the same read model.)
- **V-P1c — Auto-recovery re-reads raw pings, not `is_inactive`.** `auto-recovery.service.ts:44-48`
  drives the close off `raw_device_snapshots` after the cycle's `openedAt`, never the derived flag.
- **V-P1d — Verification re-reads raw pings.** `verification.service.ts:158-162` recomputes phase-1/2
  off `raw_device_snapshots`; `verification_runs` holds phase state so each scan is re-derivable.
- **V-P1e — Recommender capacity + committed-day-load read source of truth.**
  `recommender.service.ts:533-538` reads `engineer_master.daily_capacity/is_active` fresh per run;
  `:548-559` (`committedDayLoad`) counts real `batch_assignment_tickets` (`removed_at IS NULL`, ACTIVE
  schedules) — this is the **NEW-A1 fix already landed in code** (`:157` seeds the per-run counter from
  it), so `daily_capacity` now caps the whole day across zones/runs, not the per-zone-run in isolation.
- **V-P2a — `override.assignTicket` core is atomic.** `override.service.ts:262-297`: schedule, batch,
  batch-ticket, and the `assignmentState → FORMALLY_ASSIGNED` flip all commit in one `withAudit` tx; the
  only out-of-tx write is the best-effort notification (`:299`).
- **V-P2b — Verification `finalize` is atomic.** `verification.service.ts:257-302`: run outcome, ticket,
  cycle, `device_states`, inventory reconciliation, event, and audit in one `$transaction`.
- **V-P2c — Auto-recovery close is atomic.** `auto-recovery.service.ts:100-125` (ticket + cycle + event
  + `device_states.hasOpenFailureCycle`) in one tx.
- **V-P3a — `assignTicket` check-then-act is backstopped by a durable partial-unique.** The idempotency
  read at `override.service.ts:257` is *outside* the tx that flips the state at `:293` (a Pattern-3
  shape), **but** two concurrent same-ticket assigns cannot double-book: the second `batchAssignmentTicket.create`
  (`:290`) hits `batch_assignment_tickets_one_active_per_ticket` — `(ticket_id) WHERE removed_at IS NULL`
  (`migrations/20260621180000_add_scheduling_dispatch/migration.sql:78-79`) — and P2002s. **Residual
  (minor):** `assignTicket` does not catch that P2002, so the losing concurrent caller throws a 500
  (and, on the cross-zone path, compounds NEW-A4) rather than returning a clean `ALREADY_ASSIGNED`.
  Invariant safe; ergonomics not.
- **V-P3b — Dispatch consume window holds one xact-scoped lock.** (Re-confirms prior V4.)
  `batch-assignment.service.ts:68` takes `pg_try_advisory_xact_lock('dispatch_zone_'+zoneId)` as the
  first statement inside the `$transaction`, covering read-recs → write-schedules → consume.
- **V-P4a — Scheduler config is env-only, so "reads config at module load" is moot.**
  `readDispatchSchedulerConfig` / `readBusinessSweepSchedulerConfig` / `readIngestionSchedulerConfig`
  read `process.env.*` only (`dispatch-scheduler.service.ts:19-24`,
  `business-sweep-scheduler.service.ts:54-70`). Env is immutable at runtime, so the `@Cron(readX().cron)`
  decorator-load evaluation caches a value that could not change without a restart anyway — no
  runtime-editable-config divergence today.
- **V-P5a — Cross-zone sweep vs repeat-escalation (both `*/15`) cannot lost-update a ticket.** The
  cross-zone auto sweep makes **no ticket state change** — "a parallel decision record, not a Ticket
  state change" (`cross-zone-escalation.service.ts:55-61`); it only appends to `cross_zone_escalations`
  / `audit_log` / notifications. So even firing the same minute as repeat-escalation, there is no shared
  mutable row to race on. The pool-contention of the same-minute fan-out is the **known NEW-6**, not a
  data race.
- **V-P5b — Verification vs install-verification (both `*/5`) operate on disjoint ticket sets.**
  `verification.runVerification` scans `TROUBLESHOOT / VERIFICATION_PENDING`
  (`verification.service.ts:32-39`); install-verification scans INSTALL lifecycle rows — no shared
  mutable ticket, so concurrent fire is safe beyond the known NEW-6 pool pressure.

---

## 5. Outside scope / observations (short — not the deliverable)

- **`verification.finalize` unconditional ticket update — a NEW instance of the KNOWN #101 class.**
  `verification.service.ts:262` updates the ticket by id with no `WHERE status = 'VERIFICATION_PENDING'`
  / version guard; a concurrent `markAutoRecovery` (`:126`) or SE re-submit between the scan (`:32`) and
  `finalize` is a lost-update. This is the write-race **class** already owned by **R1/#101** (which
  enumerated auto-recovery / troubleshoot-submit / van-stock but **not** verification) — reported here as
  a not-previously-enumerated instance, not a new class.
- **Master switch captured at construction, not per-tick.** `business-sweep-scheduler.service.ts:118`
  and `dispatch-scheduler.service.ts:47` snapshot `this.config` (incl. `enabled`) in the constructor;
  `runGuarded`/`dispatchTick` read `this.config.enabled`, despite the docstrings claiming the switch is
  "re-checked on every tick." Functionally moot (it's an env var), but the doc is inaccurate and would
  become a real bug if `enabled` ever moves to DB settings.
- **Forward flag for Pattern-4 bullet 1.** V-P4a holds *only while* cadence/threshold config stays in
  env. The `zone-engine-customization` proposal (`docs/proposals/zone-engine-customization-2026-07-21.md`,
  INDEX) contemplates per-zone runtime-editable engine knobs; if cron cadence or the DEFICIT threshold
  move to DB, the `@Cron(readX().cron)` load-time evaluation (V-P4a) becomes a live "change needs a
  restart" defect. Not a finding today — a tripwire for that proposal.
- **MV DDL not read this pass.** NEW-A3 leg-1's SE-`coverage_type` sub-case and the exact plant filter
  depend on the `plant_eligible_floating_se` view definition (a migration `.sql`), which I did not open —
  hence that sub-case is marked PLAUSIBLE, not CONFIRMED.

---

*Read-only pattern-tracing audit. No code changed, no issue files created. NEW-A3/A4/A5 are unowned and
NOT filed — triage owns that. Patterns 2–5 were found to be almost entirely covered by the two prior
audits (NEW-1…NEW-7, NEW-A1/A2, NEW-C1/C2); the residual yield is Pattern-1 on the coverage MV and the
cross-zone service, plus one not-previously-enumerated #101 instance in verification.*
