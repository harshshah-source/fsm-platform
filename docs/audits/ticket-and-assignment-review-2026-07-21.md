# Ticket-Creation & SE-Assignment Adversarial Review

**Date:** 2026-07-21
**Branch:** `feat/autoplant-integration` @ `3dbe98b`
**Scope (deliberately narrow):** the two safety-critical write pipelines only —
1. **Ticket creation**: `device-state.service.ts` recompute → `eligibility.ts` gate → `device-departure.service.ts` reconcile → `ticket-creation.service.ts` write.
2. **SE assignment**: `recommender.service.ts` (+ `candidate-selection.ts`, `hard-filters.ts`) → decision-trace (`dispatch-transparency-query.service.ts`) → `batch-assignment.service.ts` → `dispatch-run.service.ts`.

**Method:** READ-ONLY. Every claim carries a `file:line` cite. Known findings are reconciled first (§1) and **not** re-surfaced; only NEW defects are reported (§2). A VERIFIED-CORRECT list (§4) states the invariants I checked and found clean, and an explicit out-of-scope list (§5) bounds the audit. No code changed, no tests run (the transparency/departure suites were read, not executed — no invariant here required a live run to prove).

**Prior record reconciled against (read in full):**
- `docs/SYSTEM-STATE-2026-07.md` §3c/§3d/§3e/§3f, §2.3/§2.4, §5.
- `docs/audits/pipeline-risk-audit-2026-07-16.md` (NEW-1…NEW-7, R1…R10).
- `.scratch/fsm-platform-v1/issues/130-stale-code-write-guard.md` (the July-19 run-65 forensic + the five-layer fix, DONE 2026-07-20).
- `.scratch/fsm-platform-v1/issues/126-dispatch-zone-wedge-orphaned-suggested-recs.md` (NEW-1 resolution).

---

## Headline

The July-19 run-65 damage class — a dangerous write trusting a **derived flag** instead of the
temporal ledger — is genuinely closed for the three gates #130 named (§4 items V1–V3). The
dispatch-wedge class (NEW-1) is genuinely closed by #126's finalized-orphan sweep (§4 V6). What the
#130/#126 work did **not** touch, and what this narrower pass surfaces, are three invariants that
are *quantitative* rather than *boolean* and so slipped past a boolean-flag audit:

1. **SE daily capacity is not enforced across zones or across runs** (NEW-A1, headline). The
   `OVER_CAPACITY` filter counts only tickets assigned *within the current in-memory zone run*; it
   never reads the DB for the SE's existing day. A FLOATING SE whose territory spans two zones is
   dispatched up to `daily_capacity` in **each** zone the run visits — a silent 2×–N× over-booking
   that every per-zone ledger reports as correct in isolation.
2. **Troubleshoot tickets with a transiently-null SLA bucket vanish from dispatch with zero trace**
   (NEW-A2), violating the recommender's own "never silently dropped" contract and leaving no
   `UNASSIGNABLE` row for the ZM to see.
3. **The departure absence-guard is a single fleet-wide ratio, not per-plant/per-page** (NEW-C1), so
   a partial-but-non-erroring source read can mass-depart a *minority* of plants — cancelling every
   open ticket on them — while staying under the 10% trip wire.

All three are LOW today (schedulers off, single operator, no real SEs) and MED the day
`BUSINESS_SWEEPS_ENABLED=true` meets real floating-SE territories and live AutoPlant reads.

---

## 1. Reconciliation — known findings (NOT re-surfaced)

`R#` reconciled against the current tree at `3dbe98b`.

| Known finding | Status now | Evidence |
|---|---|---|
| **NEW-1** dispatch zone-wedge (pipeline-audit) | **resolved (#126)** — do not re-report | `recommender.service.ts:172` `clearFinalizedOrphans` before the loop; `:402-411` excludes `run.status='RUNNING'`; per-create P2002 guard `:317-319`; post-rollback `clearRunZoneOrphans` `batch-assignment.service.ts:157,218-224`. |
| **run-65 / #130 L2** ticket-creation trusted `is_departed` | **resolved (#130 Slice 3)** | `ticket-creation.service.ts:46` now `device: { departures: { none: { restoredAt: null } } }`; recompute invariant `device-state.service.ts:127` + `departure-invariant.ts`. |
| **NEW-2** reaper reaps a live run | **still-open, out of scope** | Ingestion-side; not re-hunted (owner unchanged). |
| **NEW-3** manual dispatch bypasses in-flight guard | **still-open, out of scope here** | Scheduler-level; scope of this pass is the run *bodies*, not the schedulers. Noted as the trigger surface for NEW-A1's cross-run leg. |
| **R1 / #101** remaining write-races (auto-recovery, troubleshoot-submit, van-stock) | **still-open, out of scope** | Field-loop services, not the create/assign path. |
| **R6 / #124** config-snapshot completeness | **still-open, owned** | `dispatch-run.service.ts:204-223` still snapshots only DB-overridden rules + 2 settings; cluster-multiplier code-default + DEFICIT/PREVENTIVE threshold still uncaptured. Not re-scored. |
| **§5.14** two permanently-inert hard filters | **still-open, owned #65/#51** | `recommender.service.ts:191` `vehicleReadiness:'UNKNOWN'`, `:195` `expectedComponentsAvailable:true`. Unchanged. |
| decision-trace `scoreDegenerate` / runner-up scores | **known & documented** | The `scoreDegenerate` always-true-today behaviour and the future-correctness hazard are already called out inline (`recommender.service.ts:366-370`, ref transparency-audit note 1). Not re-reported; the *silent-drop* case that trace never covers **is** new → NEW-A2. |

---

## 2. New findings

Each: id · where · what happens · trigger · blast radius · likelihood today / after activation ·
detectability · owner.

### NEW-A1 — SE daily capacity is enforced per-zone-run only; a cross-zone floating SE is over-booked N× *(headline)*

- **Where:** `recommender.service.ts:152` (`const assigned = new Map<string, number>()` — created fresh per `runForZone`), `:193` (`overCapacity: … (assigned.get(c.seId) ?? 0) >= cap.dailyCapacity`), `:322` (`assigned.set` incremented only on a successful in-run suggestion). The map is **never seeded from the DB** — no read of the SE's existing `work_schedules`, `recommendations`, or `FORMALLY_ASSIGNED` tickets for the day. The dispatch run calls `runForZone` **once per zone in a sequential loop** (`dispatch-run.service.ts:101-105`), each call starting the map empty.
- **What happens:** `daily_capacity` is meant to cap an SE's *whole-day* workload (SYSTEM-STATE §3e: "assigned-today count ≥ engineer_master.daily_capacity"). The code instead caps *this zone's this-run* count. Two independent leaks:
  - **Cross-zone:** a FLOATING SE surfaces as a candidate for any plant in their territory (`candidate-selection.ts:35-38`, the `plant_eligible_floating_se` MV), and territories are state/region/district-scoped, so one SE legitimately covers plants in **multiple FSM zones**. Zone 1's run assigns them up to `daily_capacity`; zone 2's run starts fresh at 0 and assigns up to `daily_capacity` again. The durable backstop cannot catch it — `work_schedules_one_active_per_se_zone_day` deliberately keys on `zone_id` (SYSTEM-STATE §2.4) precisely to *allow* cross-zone plans, so two ACTIVE schedules for the same SE/day coexist by design.
  - **Cross-run / intraday:** a second dispatch run the same day (manual+cron overlap — NEW-3; or a re-run) again starts `assigned` at 0. And intraday CRITICAL insertions (`intraday-insertion.service.ts` `assignTicket`) add to the SE's plan entirely outside this accounting. So even within one zone the morning's load never counts toward the afternoon's capacity check.
- **Trigger:** any FLOATING SE whose territory covers ≥2 zones that both carry dispatchable work (cross-zone leg — needs only the normal daily run); or any second assignment pass in a day (cross-run leg).
- **Blast radius:** a capacity-25 floating SE covering 3 zones can be handed up to 75 tickets/day across 3 Day Plans they physically cannot all service — the exact "wasted truck roll" class #128 set out to kill, re-created on the assignment side. Scales with the floating-SE fraction and territory breadth.
- **Likelihood today:** LOW (no real SEs; dev floating coverage sparse). **After activation:** MED — floating SEs with multi-zone territories are the normal case for thin-coverage regions, and the daily cron visits every active zone in one loop.
- **Detectability:** LOW. Each `dispatch_run_zones` row and each `capacityUsed:{used,cap}` (`dispatch-transparency-query.service.ts:377`) is computed *per zone* and reads correct in isolation; nothing sums an SE's load across zones, so the over-booking is invisible on every existing surface.
- **Owner:** unowned (new). Adjacent to #127 (per-SE conflict isolation) but distinct — this is capacity accounting, not schedule-conflict isolation.

### NEW-A2 — Troubleshoot tickets with a null SLA bucket are silently dropped from the recommender (no recommendation, no UNASSIGNABLE row)

- **Where:** `recommender.service.ts:122` — `const rankable = tickets.filter((t) => t.device.state?.slaBucket != null)`. Tickets failing this filter never enter `runList`, so they are absent from `ticketsConsidered` (`:389 runList.length`), produce no `recommendations` row (neither `SUGGESTED` nor `UNASSIGNABLE`), and write no `dispatch_decision_trace`.
- **What happens:** the docstring at `:82-84` promises "No eligible SE → an UNASSIGNABLE row (never silently dropped)". A null `sla_bucket` breaks that promise silently. `sla_bucket` is NULL in two derivable states (`device-state.service.ts:109`): (a) the 0–4h ACTIVE band, and (b) a departed device. Departed tickets are already filtered at `:113`, but (a) is reachable: a device that resumed pinging (inactivity fell back under 4h) whose `failure_cycle` has not yet been auto-recovered still carries an OPEN/UNASSIGNED TROUBLESHOOT ticket with a now-null bucket; and if `inactivity_threshold_hours` is ever lowered below 4, ticket creation itself opens tickets for still-null-bucket devices. Either way the ticket exists, is dispatchable in principle, and disappears from the run with zero operator-visible trace.
- **Trigger:** an OPEN/UNASSIGNED TROUBLESHOOT ticket whose device's `device_states.sla_bucket` is NULL at recommender time (device re-pinging pre-auto-recovery, or a sub-4h inactivity threshold).
- **Blast radius:** bounded (a handful of tickets in the recompute↔auto-recovery window), but each is invisible — not on the run's unassignable card, not in the trace, not in `ticketsConsidered`. A ZM auditing "why wasn't this dispatched?" finds nothing.
- **Likelihood today:** LOW. **After activation:** LOW–MED (the recompute/auto-recovery window is real at 30-min ticks and mass-recovery events).
- **Detectability:** LOW — this finding *is* a detectability hole; the transparency ledger's whole premise is that nothing drops without a reason row, and this path drops without one.
- **Owner:** unowned (new).

### NEW-C1 — Departure absence-guard is a single fleet-wide ratio; a partial non-erroring source read mass-departs a minority of plants

- **Where:** `device-departure.service.ts:180-192` — `absenceRatio = absent.length / inScopeDevices`; `guardTripped = absent.length > 0 && absenceRatio > maxAbsenceRatio` (default `0.1`, `:50`). The guard is computed **once, globally**, over the whole in-scope fleet. `syncedPlantIds` is the set of ACTIVE plants the run *intended* to cover (`master-sync.service.ts:369` `[...plantIdBySource.values()]`), independent of which plants the vehicle read actually returned rows for.
- **What happens:** absence (`ABSENT_FROM_READ` → `MISSING_FROM_SOURCE`) is inferred for any in-scope device whose `device_id` is not in `observed` (`:167-174`), and opening a departure **cancels all that device's open tickets, FAILs its cycle, clears `has_open_failure_cycle`** in one tx (`:283-316`). If the widened `mst_vehicle` read returns a **short result without throwing** (a transient that ends a keyset page early, so the drain believes it finished), every device in the un-read tail is inferred absent. When that tail is a minority of the fleet — e.g. one large plant, or the last keyset page's worth of devices — `absenceRatio` stays under 0.10 and the guard **does not trip**: those devices are departed and their open tickets cancelled. The guard only defends against a *majority* vanishing; a partial read affecting <10% passes clean.
- **Trigger:** a non-erroring partial/short vehicle read (VPN hiccup that truncates rather than errors, a source-side `LIMIT`/timeout returning a short page) covering <10% of the in-scope fleet. (A read that *throws* fails the whole master run — safe; this is specifically the silent-short-read case.)
- **Blast radius:** up to ~10% of the fleet departed + every open ticket on those devices `CLOSED / DEVICE_UNDEPLOYED_CLOSE` in a single run — on devices that never actually left the fleet. Self-heals on the next full read (restore path), but the cancelled tickets do not un-cancel; they must be re-created by the pipeline.
- **Likelihood today:** LOW (departure reconcile runs only on the daily master tick, scheduler off). **After activation:** LOW–MED — depends on whether the keyset reader can terminate a drain on a short page without an error; the existing guard proves the authors already treat truncated reads as a real threat, this is the sub-threshold slice it misses.
- **Detectability:** MED — `DEVICE_DEPARTED` audit rows + the reconcile log line record it, but nothing alerts on a sub-guard absence spike, so it reads as normal churn.
- **Owner:** unowned (new); adjacent to #128. **Verdict: PLAUSIBLE** — conditional on the reader's short-read behaviour (not traced this pass; see §5).

### NEW-C2 — Ticket-creation reads `deactivatedPlantIds` once, before its per-device loop (minor TOCTOU)

- **Where:** `ticket-creation.service.ts:30-32` reads the active-deactivation set, then the candidate query (`:33-51`) and the per-device transaction loop (`:62-118`) run against that snapshot.
- **What happens:** if a plant is deactivated *after* this read but *before* the loop reaches one of its devices, a fresh TROUBLESHOOT ticket is still opened for that device. The plant-deactivation tx cancels *existing* open tickets (§3d) but cannot see a ticket created moments later, so the deactivated plant ends up with one live ticket the deactivation was supposed to prevent.
- **Trigger:** an OH deactivating a plant concurrently with a ticket-creation run — manual, rare.
- **Blast radius:** a few stray tickets on a just-deactivated plant; corrected next run (the plant is then in the snapshot and its stray ticket is not re-created, but also not auto-cancelled — a manual close or a re-deactivate is needed).
- **Likelihood:** LOW both. **Detectability:** MED (ticket appears under a deactivated plant). **Owner:** unowned (new, minor).

---

## 3. Ranked (blast × likelihood-post-activation × inverse-detectability)

1. **NEW-A1 — cross-zone/cross-run capacity leak.** Highest product: real blast (a physically-impossible 2×–N× day plan per multi-zone floating SE), MED post-activation likelihood (multi-zone territories are the norm for thin coverage; the daily loop guarantees the condition), and LOW detectability (every per-zone surface reads correct — nothing aggregates the SE across zones). It is the #128 "wasted truck roll" waste re-created on the assignment side, and no durable unique can catch it because the schedule unique intentionally allows cross-zone plans.
2. **NEW-C1 — sub-guard partial-read mass-departure.** Whole-plant blast with irreversible ticket cancellation, MED detectability, but ranked below A1 because the trigger is conditional on a specific reader failure mode (silent short read) not confirmed this pass. If confirmed, it rises to #1 — cancelling live field work is worse than over-booking it.
3. **NEW-A2 — silent null-bucket drop.** Low direct blast but it punctures the transparency guarantee the whole dispatch-ledger investment rests on: a ticket that should dispatch disappears with no reason row anywhere. Low likelihood, low detectability.
4. **NEW-C2 — deactivation TOCTOU.** Minor; rare manual trigger, self-limiting, visible.

---

## 4. VERIFIED CORRECT (checked this pass, found clean)

- **V1 — Ticket creation re-reads the departure ledger, not the flag.** `ticket-creation.service.ts:46` gates on `device: { departures: { none: { restoredAt: null } } }` (source of truth), the run-65 fix. Confirmed against the derived-flag path it replaced (#130 L2).
- **V2 — Recommender TROUBLESHOOT selection re-reads the departure ledger.** `recommender.service.ts:113` same shape; defence-in-depth on top of departure-time cancellation. Install backlog deliberately (and correctly) *not* departure-filtered (`:441-444`).
- **V3 — Recompute derives `is_departed` from the side table AND asserts the invariant in the same transaction, rollback-and-throw.** `device-state.service.ts:75-78,95-129` + `departure-invariant.ts:13-31`: a departed device that somehow stayed operational throws inside the tx and rolls the UPDATE back atomically — the run-65 corruption can no longer commit.
- **V4 — Dispatch advisory-lock scope covers the full consume window for same-zone concurrency.** `batch-assignment.service.ts:62-151`: `pg_try_advisory_xact_lock` is the first statement *inside* the `$transaction`, so read-recs → write-schedules → `SUGGESTED→DISPATCHED` consume all sit under one xact-scoped lock; a second concurrent dispatch of the same zone gets `locked=false` and returns `LOCK_CONTENDED` without touching the other's recs (`:69-72,176-178`). (Note: the *recommender* phase runs before this lock — that is NEW-3's territory, out of scope here.)
- **V5 — Ticket-creation idempotency (invariant I1).** `ticket-creation.service.ts:79-118`: the three writes commit in one tx; a P2002 on the one-active-cycle-per-device partial unique is caught and the device silently skipped (`:116`), so a stale `has_open_failure_cycle` read can never double-open a cycle.
- **V6 — #126 orphan sweep never deletes a live concurrent run's recs.** `recommender.service.ts:402-411` clears only `runId IS NULL OR run.status != 'RUNNING'`; recs owned by a still-RUNNING dispatch are left for the per-create P2002 guard to skip (`:317-319`). The zone can no longer P2002-wedge, and a concurrent live run is not clobbered.
- **V7 — Eligibility mode fails safe.** `eligibility.ts:25` `parseEligibilityMode` returns `'pgi'` for any junk/unset value — the gate never silently widens to `all-deployed`.
- **V8 — Both #119-deactivated and #128-departed are checked on every troubleshoot work-generating path.** Creation: deactivated (`ticket-creation.service.ts:48`) + departed (`:46`). Dispatch: deactivated (`recommender.service.ts:109`) + departed (`:113`). No troubleshoot path generates work for a shut plant or a departed device.
- **V9 — Departure reconcile is atomic.** `device-departure.service.ts:210-214`: departures opened, tickets cancelled, cycles FAILed, `has_open_failure_cycle` cleared, and audit rows all commit in one `$transaction` — no half-departed orphan state (the NEW-1-family shape does not exist here).
- **V10 — No config-drift in the create/assign hot paths.** `eligibility_mode` + `inactivity_threshold_hours` (`device-state.service.ts:56-58`), `plant_cluster_multiplier` (`recommender.service.ts:522-525`), and active weight sets (`:496`) are all read fresh **per run/recompute** from settings/DB — an ops edit takes effect on the next tick, no restart needed. (The cron *expressions* are boot-cached, but that is the scheduler layer, §5.)
- **V11 — Transparency reads are zone-clamped.** `dispatch-transparency-query.service.ts:334,473,562` clamp a ZONAL_MANAGER to their own zone at zone-detail, batch-detail, and ticket-trace; CSM/OH see all. No cross-zone read leak on the ledger surface.
- **V12 — Dispatch capacity denominator is frozen at run start.** `dispatch-run.service.ts:204-215` snapshots the per-SE `daily_capacity` map onto the run; `capacityFromSnapshot` (`dispatch-transparency-query.service.ts:644-653`) reads it back, so a later `engineer_master` capacity edit cannot rewrite a historical run's "used/cap" denominator. (This is the *display* denominator; the *enforcement* gap is NEW-A1 — a distinct concern.)

---

## 5. Explicitly NOT in scope this audit

- **Schedulers themselves** (`dispatch-scheduler.service.ts`, `business-sweep-scheduler.service.ts`, `integration-scheduler.service.ts`) — cron caching, in-flight guards, NEW-2/NEW-3/NEW-4/NEW-5/NEW-6, multi-instance HA. Owned by the pipeline-risk audit; the trigger surface for NEW-A1's cross-run leg is noted but the scheduler bodies were not re-hunted.
- **Ingestion** (snapshot worker, master-sync mirror mechanics, run ledger/reaper, partitioning). The departure *reconcile* was reviewed as the writer of the `is_departed`/ticket-cancellation state (NEW-C1); the AutoPlant **reader's short-read behaviour** — the trigger NEW-C1 depends on — was NOT traced and is the open question that would confirm or downgrade it.
- **Field-loop services** (auto-recovery, troubleshoot-submission, verification, install/recovery/non-op, inventory) and the #101 write-race set (R1).
- **Auth / RBAC / rate-limiting** (#91/#98/#99/#110), **DR/#111**, **PGI feed/#116**, **cross-zone read-model/#93**.
- **Admin FE / dashboards / exports** and all React concerns (except the read-side zone-clamp verified as V11).
- **Config-snapshot completeness (#124)** and the two inert hard filters (#65/#51) — reconciled as still-open (§1), not re-scored.

---

*Read-only audit. No code changed, no issue files created. NEW-A1, NEW-A2, NEW-C1, NEW-C2 are
unowned and NOT filed — triage owns that decision. NEW-C1 is marked PLAUSIBLE pending a trace of the
AutoPlant reader's short-read semantics; the rest are CONFIRMED against the cited lines.*
