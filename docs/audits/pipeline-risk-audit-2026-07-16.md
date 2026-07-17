# Pipeline Risk Audit — Ingestion · Schedulers · Batch Assignment

**Date:** 2026-07-16
**Branch:** `feat/autoplant-integration` @ `6e92e25`
**Scope (deliberately narrow):** the injection pipeline (AutoPlant → snapshot → device-state →
tickets), the three schedulers (ingestion / business sweeps / dispatch), and batch assignment
(recommender → dispatch → `work_schedules`). Auth, docs-tracking, PGI, cross-zone read-model and
FE are **out of scope** — reconciled for completeness (§1) but not adversarially re-hunted.
**Method:** READ-ONLY. Reconcile every known finding against the current tree with file:line
evidence, then hunt adversarially for what the prior audits missed. No code changed. No fixes
proposed inline (that is a separate per-finding session). Every claim carries a file:line cite or
is marked `[UNVERIFIED]`.

**Prior record reconciled against:** `docs/SYSTEM-STATE-2026-07.md` §5 (14 ranked gaps),
`docs/audits/2026-07-03-*`, `docs/audits/2026-07-07-*` (both), INDEX Next-up + open issues.

---

## Headline

The pipeline's *ingestion* half is as robust as the prior audits found — the run-456 orphan class is
genuinely closed (`snapshot-ingestion.worker.ts:70-104`), writes are idempotent, health surfaces
staleness. The **new** risk sits in the two places the earlier audits examined least adversarially:

1. **The dispatch write path can permanently wedge an entire zone** (NEW-1) — a single rolled-back
   dispatch transaction leaves orphaned `SUGGESTED` recommendations that nothing cleans up, and the
   recommender then P2002s against them on *every* subsequent run for that zone. This is the
   run-456 failure *family* reborn on the dispatch side, and it is the top finding.
2. **The stale-run reaper reaps runs that are still alive** once run-time exceeds
   `INGESTION_STALE_RUN_MIN` (NEW-2) — whose default (30 min) equals the telemetry cadence, and
   which at target fleet scale a normal run *will* exceed — silently breaking the single-in-flight
   guarantee the whole run ledger exists to provide.

Both are LOW today (schedulers off, single operator, dev fleet) and MED–HIGH the day
`BUSINESS_SWEEPS_ENABLED` flips with real volume.

---

## 1. Reconciliation — known findings against the current tree

`R#` = reconciled item. Status ∈ {still-open · partially-addressed · no-longer-real}. In-scope items
carry fresh file:line; out-of-scope §5 items are reconciled against SYSTEM-STATE/INDEX and flagged
`[not re-verified this session]` where I did not re-read the code (honest, not dropped).

| R# | Known finding (source) | Status | Evidence at `6e92e25` |
|---|---|---|---|
| R1 | §5.5 / #101 remaining write-races | **still-open (partial)** | `transitionOrConflict` adopted **only** in `intraday/intraday-insertion.service.ts` (:156,:189,:442,:454). SE-submit vs auto-recovery: `ticketing/auto-recovery.service.ts:101,105,121` still bare `update`/`updateMany` off a JS read; `ticketing/troubleshoot-submission.service.ts:155,159,207,211` same idiom; van-stock stale-read decrement `troubleshoot-submission.service.ts:317-319` `qty: Math.max(0, row.qty - qty)`. #101 file confirms `Status: partial`. |
| R2 | §5.6 / #106 perf cliffs | **still-open** | `prisma/prisma.service.ts:14-25` — adapter sets **only** session `-c timezone=UTC`; no pool size, no `connect`/`statement_timeout`. `#106 Status: ready-for-agent`. Dispatch does a per-ticket `ticket.update` loop inside one zone-wide tx (`scheduling/batch-assignment.service.ts:114-127`). |
| R3 | §5.7 / #103 hot-FK indexes | **still-open** | `#103 Status: ready-for-agent`; schema not re-diffed this session `[not re-verified]`, issue open. |
| R4 | §5.12 clock drift / TZ | **partially-addressed** | DB-session half **closed**: adapter pins `timezone=UTC` (`prisma.service.ts:23`), neutralising the "session TimeZone=Asia/Calcutta" leg of validation-audit finding 3. **Container clock drift ~5.5h is env, not code, and remains** — downstream effect concrete: `device-state.service.ts:73` computes `inactivity_hours` from `${now}` = container wall-clock; a fast clock inflates every device's inactivity → premature `is_inactive`/tickets. |
| R5 | §5.10 / #104 partition config-drift | **still-open** | Partition maintenance is its **own** `@Cron('10 0 * * *')` gated solely by `PARTITION_MAINTENANCE_ENABLED` (`ingestion/partition-maintenance.service.ts:51-53`), independent of `INGESTION_SCHEDULER_ENABLED` — the documented "must flip together" hazard is real. `CREATE_AHEAD_DAYS=3` runway (`:13`); no DEFAULT-partition watchdog (the #104 AC). `#104 Status: ready-for-agent`. |
| R6 | Gap B — config-snapshot completeness | **still-open (owned #124)** | `scheduling/dispatch-run.service.ts:199-218` snapshots only DB-overridden `priority_rule_config` + two settings; empty when the recommender falls back to code defaults (`recommender.service.ts:466-472`, `DEFAULT_CLUSTER_MULTIPLIER`). Also does **not** capture the soft-inactive `threshold_pct` that selects DEFICIT/PREVENTIVE. `#124 Status: ready-for-agent`. |
| R7 | 07-03 #4 / run-456 orphan (ingestion) | **no-longer-real** | Worker wraps the drain in try/catch and *always* finalizes (`snapshot-ingestion.worker.ts:70-104,130-134`); reaper flips stale RUNNING→FAILED before the guard (`snapshot-run.service.ts:33-43`). **But see NEW-2** — the reaper introduced an adjacent race. |
| R8 | 07-03 #2 dispatch non-transactional/non-consuming | **no-longer-real (superseded)** | Dispatch is now one `$transaction` + advisory lock + `SUGGESTED→DISPATCHED` consume (`batch-assignment.service.ts:54-140`). Partial-uniques exist (`migrations/20260708120000`). **But the fix is incomplete — see NEW-1.** |
| R9 | 07-03 #6 DEFAULT-partition / O(fleet) recompute | **no-longer-real** | Real daily partitions + planner (`partition-planner.ts`); recompute is two set-based statements (`device-state.service.ts:48-96`), watermark maintained at ingest (`snapshot-ingestion.service.ts:95-102`). |
| R10 | 07-03 #1 no scheduler / stub reader | **no-longer-real** | `IntegrationSchedulerService` (telemetry `*/30`, masters daily), real `AutoPlantSourceReader` bound when configured (`ingestion.module.ts:131-147`). |
| — | §5.1 auth (#91/#98/#110) | out-of-scope | #98 done per SYSTEM-STATE (`25a46d4`…); #91 in-memory store + #110 rate-limiting still-open per INDEX. `[not re-verified this session]` |
| — | §5.2 DR/#111 · #115 docs-gitignore · #114 | out-of-scope | Owners unchanged per INDEX. `[not re-verified]` |
| — | §5.4 #116 PGI feed · §5.13 #93 cross-zone · §5.14 #65/#51 funnel filters | out-of-scope | Owners unchanged. The two permanently-inert hard filters remain visible in-scope: `recommender.service.ts:178` `vehicleReadiness: 'UNKNOWN'` and `:182` `expectedComponentsAvailable: true` — both hard-coded, cannot fire (§3e table still accurate). |
| — | §5.3 UNZONED derivation · §5.8 #105 wiring · §5.9 #107 CI · §5.11 #99 guard | mixed | #99 done (`aaf233e`, global `APP_GUARD`) per SYSTEM-STATE; #105/#107 open; UNZONED reduced to ~18% operational. `[not re-verified this session]` |

Nothing from SYSTEM-STATE §5 is dropped. Two items reclassified **no-longer-real** (R7, R9, R10 for
ingestion; R8 for the dispatch mechanism) are cross-checked in §4 — with the caveat that R7/R8's
"fixed" mechanisms each spawned a *new* adjacent defect (NEW-2, NEW-1).

---

## 2. New findings

Each row: id · where · what happens · trigger · blast radius · likelihood today / after activation ·
detectability · owner.

### NEW-1 — Dispatch wedges an entire zone via orphaned `SUGGESTED` recommendations *(headline)*

> **RESOLVED 2026-07-16 by #126** (guard-not-throw + finalized/null-run orphan sweep + post-rollback cleanup + reason-annotated zone skip; TDD `test/dispatch-zone-wedge.e2e-spec.ts`). Per-SE isolation of the conflict is the fast-follow #127.

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
  cancel — no `statement_timeout`, R2). (c) two concurrent dispatch runs of the same zone (NEW-4).
- **Blast radius:** an entire zone's daily auto-dispatch is dead. On the 2026-07-13 live run East and
  UNZONED each dispatched 150–158 tickets/day; at real volume that is hundreds of field tickets left
  `OPEN/UNASSIGNED` per wedged zone per day. Also note the whole-zone tx is all-or-nothing: one SE's
  stale schedule blocks *every other SE's* dispatch in that zone.
- **Likelihood today:** LOW (dispatch is manual, single operator, no ZM overrides pre-empting the
  run). **After activation:** MED — the 05:00 cron and ZM overrides coexist daily; any zone-tx
  rollback is a one-way trip to the wedge.
- **Detectability:** MED — visible as a per-zone `error` in `dispatch_run_zones` + a log line
  (`dispatch-run.service.ts:114`), but **not** on `/api/integration/health` (which covers only
  ingestion — NEW-5), and the *root cause* (orphaned recs) is non-obvious. No alert, no auto-heal.
- **Owner:** unowned (new).

### NEW-2 — Reaper reaps a still-alive run → concurrent double-drain + `finishRun` un-reap

- **Where:** `ingestion/snapshot-run.service.ts:33-40` (`reapStaleRuns`), `:43` (called first in
  `startRun`), `:85-93` (`finishRun` unconditional `update where runId`); `ingestion/stale-run.ts:11`
  (`DEFAULT_STALE_RUN_MIN = 30`); `ingestion/autoplant/integration-scheduler.service.ts:23`
  (`DEFAULT_TELEMETRY_CRON = '*/30'`). Same shape in `master-sync-run.service.ts:41-48`.
- **What happens:** `@nestjs/schedule` does **not** serialize overlapping cron invocations — the
  code relies entirely on the DB run guard. When a telemetry run's wall-time exceeds
  `INGESTION_STALE_RUN_MIN`, the *next* tick's `startRun()` calls `reapStaleRuns()` first, which
  flips the **still-running** run's row `RUNNING→FAILED` (`startedAt < now − 30min`). The partial
  unique `snapshot_runs_one_in_flight` no longer sees a RUNNING row, so the new tick creates its own
  and **both drain concurrently**. Data stays correct (writes are `ON CONFLICT DO NOTHING`,
  ticket-create is I1-guarded), but: (i) double VPN + DB write load; (ii) when the reaped-but-alive
  run finishes, `finishRun` **unconditionally** overwrites its row back to `SUCCESS/PARTIAL`
  (`:85-93`) — a "zombie" run resurrects itself and re-advances `data_as_of`/`cursor`, erasing the
  reaper's FAILED verdict. The single-in-flight guarantee — the entire point of the run ledger — is
  silently void whenever run-time > threshold.
- **Trigger:** run-time > `INGESTION_STALE_RUN_MIN`. Default 30 min **equals** the telemetry cadence
  and the reaper threshold, so the margin is zero. Snapshot ingest was 353 s at 18k devices
  (07-07 validation audit); linear-ish to ~300k target ⇒ ~90 min ≫ 30 min. At target scale **every**
  run trips this. A slow-VPN night trips it at current scale.
- **Blast radius:** broken single-in-flight across the whole ingestion subsystem; doubled source/DB
  load during the overlap; a run an operator/reaper believes dead can silently resurrect and move the
  freshness watermark. No row corruption observed, but the invariant the ledger sells is gone.
- **Likelihood today:** LOW (schedulers off; dev runs ~7 min). **After activation:** MED at current
  scale, **HIGH at target scale** (guaranteed). The documented mitigation (§6.2 "set
  `INGESTION_STALE_RUN_MIN` above telemetry cadence") is **insufficient**: it must exceed max
  *run-time*, and the cadence itself must exceed run-time or ticks pile up — neither is enforced or
  validated at boot.
- **Detectability:** LOW / silent — health shows the resurrected `SUCCESS`; the transient FAILED and
  the overlap leave no durable trace beyond interleaved log lines.
- **Owner:** unowned (new); adjacent to #97/#104.

### NEW-3 — Manual dispatch trigger bypasses the single-in-flight guard entirely

- **Where:** guard lives on `scheduling/dispatch-scheduler.service.ts:41,53-57` (`inFlight` boolean,
  **on the scheduler**); the manual HTTP path calls `DispatchRunService.runForActiveZones`
  (`dispatch-run.service.ts:69`) directly, which has **no** in-flight guard of its own.
- **What happens:** the cron's `inFlight` boolean serializes only cron-vs-cron. A manual
  `POST /schedules/dispatch-run` (operator) firing while the 05:00 cron runs — or two operators —
  runs `runForActiveZones` concurrently. Per zone, two recommenders race to write `SUGGESTED` rows →
  P2002 collisions on `recommendations_one_suggested_per_ticket`, surfacing as zone errors and
  feeding **NEW-1**'s orphan condition.
- **Trigger:** manual trigger overlapping the cron, or two manual triggers.
- **Blast radius:** per-zone dispatch errors + potential NEW-1 wedge.
- **Likelihood:** today LOW (manual only, off); after activation MED (cron + operator coexist).
- **Detectability:** MED (zone errors in ledger).
- **Owner:** unowned (new); compounds NEW-1.

### NEW-4 — Business sweeps + dispatch have no run ledger and no health surface (silent failure)

- **Where:** `scheduling/business-sweep-scheduler.service.ts:125-141` (tick `catch`→`logger.error`→
  returns `{ran:false,reason:'ERROR'}` — the outcome is **discarded** by the cron caller);
  `dispatch-scheduler.service.ts:61-63` same; `ingestion/autoplant/health.service.ts:96-104`
  (health covers **only** master-sync + snapshot).
- **What happens:** the 10 business sweeps (verification, intraday-timeout, cross-zone, install-verif,
  repeat-escalation, soft-inactive, 4 report cubes) and the dispatch tick have **no persistent run
  record** — unlike ingestion (`snapshot_runs`) and dispatch *runs* (`dispatch_runs`, which only the
  *manual/cron dispatch* writes, not the field-loop sweeps). A sweep that throws on every fire logs to
  stdout and vanishes. E.g. the intraday-timeout sweep silently failing means offers never time out
  and the field loop stalls — invisible to `/api/integration/health` and to every dashboard.
- **Trigger:** any recurring exception in a sweep (bad data row, missing FK, a downstream service
  bug) after `BUSINESS_SWEEPS_ENABLED=true`.
- **Blast radius:** an entire field-loop sweep can be dead for hours/days with no operator signal;
  worsens the detectability of NEW-1 and every #101 race.
- **Likelihood:** today LOW (off); after activation MED (10 unguarded sweeps × real data edge cases).
- **Detectability:** LOW / log-only — this finding *is* a detectability hole.
- **Owner:** unowned (new); relates to #108 (which built the scheduler but no ledger).

### NEW-5 — In-memory single-in-flight resets on restart and does not coordinate across instances

- **Where:** `business-sweep-scheduler.service.ts:103` (`inFlight = new Set<string>()`, per-process);
  `dispatch-scheduler.service.ts:41` (`inFlight = false`, per-process). Contrast the **durable**
  DB-level guard the ingestion path uses (`snapshot_runs_one_in_flight`).
- **What happens:** the sweeps' overlap protection is a process-local Set/boolean. On a container
  restart mid-sweep the flag resets (harmless alone). But with **>1 instance** (HA — undecided,
  #111), both instances fire the same cron and the in-memory guard cannot see the other → concurrent
  verification / cross-zone / dispatch sweeps. The comment at
  `business-sweep-scheduler.service.ts:93-94` is explicit: "the underlying sweeps carry no guard of
  their own." So the #101 races (double van-stock rollback, double auto-recovery — R1) fire for real
  the moment a second instance exists.
- **Trigger:** running ≥2 backend instances (any HA / rolling-deploy overlap).
- **Blast radius:** the full #101 concurrency-corruption set, cluster-wide.
- **Likelihood:** today LOW (single instance, off); after activation **conditional on the #111
  deployment decision** — if HA is chosen, MED-HIGH.
- **Detectability:** LOW (silent state corruption; no concurrency tests exist — 07-03 audit).
- **Owner:** unowned (new); gated by #111, amplifies #101.

### NEW-6 — Cron fan-out collision at minute :00 against the all-default pool

- **Where:** `business-sweep-scheduler.service.ts:27-36` crons + `dispatch-scheduler.service.ts:10` +
  `partition-maintenance.service.ts:51` + `integration-scheduler.service.ts:21-23`, over the
  pool-less `prisma.service.ts:14-25` (R2).
- **What happens:** at every hour's `:00`, verification (`*/5`), install-verification (`*/5`),
  intraday-timeout (`*/2`), cross-zone (`*/15`) and repeat-escalation (`*/15`) all fire in the same
  minute; the three monthly cubes are staggered from **each other** (03:00/03:15/03:30) but **not**
  from the frequent `:00/:15/:30` sweeps, so 03:00 on the 1st stacks the heavy `fleet-uptime` cube on
  top of five frequent sweeps. All draw from one unbounded, timeout-less Postgres pool. A mass-outage
  morning (thousands of `VERIFICATION_PENDING` tickets, thousands of dispatch `ticket.update`s) turns
  this into pool-contention / long-transaction pile-up.
- **Trigger:** clock `:00` (always) + high row volume.
- **Blast radius:** latency spikes / connection starvation across unrelated requests; raises the
  probability of the transient-rollback trigger for NEW-1.
- **Likelihood:** today LOW; after activation MED (guaranteed collision; impact scales with volume).
- **Detectability:** MED (slow queries, but no metrics — 07-07 audit).
- **Owner:** unowned (new); overlaps #106.

### NEW-7 — Offset change re-counts telemetry across runs *(minor)*

- **Where:** `ingestion/autoplant/mapping.ts:15,99-134` (offset applied at map time), raw unique
  `(device_id, gps_datetime)`.
- **What happens:** `raw_device_snapshots` idempotency keys on the *normalized* `gps_datetime`.
  Changing `AUTOPLANT_SOURCE_UTC_OFFSET_MIN` between runs remaps the same source wall-clock to a
  different UTC instant → a **new** row for the same physical ping (no conflict) → double-counted
  telemetry and a spurious `latest_gps_datetime` shift.
- **Trigger:** an operator edits the offset env (rare, manual, restart-only).
- **Blast radius:** small telemetry over-count for one run's window; self-corrects next run.
- **Likelihood:** LOW both. **Detectability:** LOW (silent). **Owner:** unowned (new).

> **Addendum 2026-07-17:** a departure blind spot NOT caught here was confirmed and quantified —
> master sync never observes `DEPLOYED→UNDEPLOYED` (~37 % of FSM devices stale; 42.5 % of live-batch
> devices undeployed at source) — see `deployment-lifecycle-investigation-2026-07-17.md` / issue #128.

---

## 3. Ranked list (blast × likelihood-after-activation × inverse-detectability)

### Top 10 (one-paragraph rationale)

1. **NEW-1 — dispatch zone wedge.** Highest product of the three factors: whole-zone blast (hundreds
   of undispatched tickets/day), a MED trigger surface that includes the *normal* ZM-override
   workflow, and no self-heal — the zone stays dead until someone finds and deletes orphaned
   `SUGGESTED` rows. It is the run-456 orphan pattern transplanted onto the dispatch side, and the
   "fixed" R8 dispatch idempotency is exactly what conceals it (the P2002 backstop fires as an
   unhandled throw, not the intended clean skip).

2. **NEW-2 — reaper reaps a live run.** At target fleet scale a normal run *guaranteed* exceeds the
   30-min default threshold, so the single-in-flight invariant is not "at risk" but *void*; the
   `finishRun` un-reap makes it self-concealing. Silent detectability pushes it above the #101 set.

3. **R1 — #101 remaining write-races (still-open).** High corruption blast (double stock decrement,
   erased confirmations, stuck `PRE_VERIFICATION` ledgers), MED likelihood once sweeps + concurrent
   SEs land, LOW detectability (zero concurrency tests). Known, owned #101 (partial). The helper
   exists; only intraday is converted.

4. **NEW-5 — in-memory sweep lock vs multi-instance.** If #111 chooses HA, this unlocks the entire
   #101 race set cluster-wide with a silent failure mode. Ranked here (not higher) only because the
   trigger is gated on an undecided deployment choice.

5. **NEW-3 — manual dispatch bypasses the in-flight guard.** Direct feeder of NEW-1; the intended
   serialization simply doesn't cover the manual+cron overlap that daily operations will produce.

6. **R2 — #106 pool/timeout.** No `statement_timeout` + default pool is the amplifier under
   everything above: it converts a slow zone-wide dispatch tx into the deadlock/cancel that triggers
   NEW-1, and makes NEW-6 bite. Cheap, high-leverage. Owned #106.

7. **NEW-6 — cron fan-out at :00.** Guaranteed collision; impact is volume-gated but the mass-outage
   morning is precisely when dispatch and verification are busiest. Owned-adjacent #106.

8. **NEW-4 — no sweep/dispatch ledger or health.** Low *direct* blast but it is a force-multiplier on
   every other finding's detectability — a dead sweep or a wedged zone is invisible outside stdout.
   Fixing it is how the rest become operable.

9. **R5 — #104 partition config-drift.** Silent DEFAULT-partition re-accumulation if
   `PARTITION_MAINTENANCE_ENABLED` is not flipped with ingestion (independent `@Cron`); recreates the
   exact condition R3 fixed. Owned #104, MED, needs the watchdog AC.

10. **R4 — clock-drift downstream.** Container ~5.5h drift inflates `inactivity_hours` → premature
    `is_inactive`/tickets. Env-owned, MED; the DB-session TZ half is already closed in code.

### Remainder (one line each)

- **R6 / #124** — config snapshot records only DB-overridden values → transparency panel blank on
  code-default runs; also omits the DEFICIT/PREVENTIVE threshold. Owned #124.
- **R3 / #103** — hot-FK indexes still absent; ticket-volume seq-scans. Owned #103.
- **NEW-7** — offset-change telemetry re-count; rare, self-correcting, silent. Unowned.
- **§5.14** — two hard filters permanently inert (`vehicleReadiness:'UNKNOWN'`,
  `expectedComponentsAvailable:true`; `recommender.service.ts:178,182`). Owned #65/#51.
- **Out-of-scope §5 carry-overs** (auth #91/#110, DR #111, docs #115/#114, PGI #116, cross-zone #93)
  — owners unchanged; not re-hunted here.

---

## 4. Cross-check — items reclassified "no-longer-real"

Nothing from SYSTEM-STATE §5 is silently dropped. The reclassifications below are the *prior-audit*
CRITICALs now fixed; each shows the evidence — and, where the fix spawned a new defect, the pointer.

| Reclassified | Evidence it was fixed | New defect it introduced |
|---|---|---|
| 07-03 #1 (no scheduler / stub reader) → fixed | `IntegrationSchedulerService` + real `AutoPlantSourceReader` (`ingestion.module.ts:131-147`); 07-07 re-audit Part 1 | — |
| 07-03 #4 / run-456 orphan (ingestion) → fixed | worker try/catch always finalizes (`snapshot-ingestion.worker.ts:70-104,130-134`); reaper (`snapshot-run.service.ts:33-43`) | **NEW-2** (reaper reaps live runs; `finishRun` un-reap) |
| 07-03 #2 (dispatch non-tx / non-consuming) → fixed | `$transaction` + advisory lock + consume (`batch-assignment.service.ts:54-140`); partial-uniques (`migrations/20260708120000`) | **NEW-1** (orphaned `SUGGESTED` wedge; P2002 backstop fires as unhandled throw) |
| 07-03 #6 (DEFAULT partition / O(fleet) recompute) → fixed | partitions + planner; set-based recompute (`device-state.service.ts:48-96`); ingest watermark (`snapshot-ingestion.service.ts:95-102`) | — (R5/#104 is the residual retention-config gap, already owned) |

No `[UNVERIFIED]` claims in the in-scope findings; out-of-scope §5 items are explicitly flagged
`[not re-verified this session]` rather than asserted.

---

*Read-only audit. No code changed. Findings are ranked, not fixed — per the session contract,
proposals come as a separate per-finding session after triage. New findings NEW-1…NEW-7 are unowned
and NOT yet filed as issues (triage session owns that decision).*
