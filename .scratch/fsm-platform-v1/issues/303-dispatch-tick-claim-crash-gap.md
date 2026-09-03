# 303 — The dispatch day survives a crash between tick claim and run admission
Status: **done** (2026-09-02) — report [`docs/progress/303-dispatch-tick-claim-crash-gap.md`](../../../docs/progress/303-dispatch-tick-claim-crash-gap.md). **Neither offered design was needed: no new column, no claim heartbeat, no migration.** The evidence a surviving tick leaves already exists — it dispatched zones — so the janitor reads `dispatch_run_zones` instead. Grace period is composed from the two existing knobs (#260 retry deadline + dispatch stale-run threshold = 25 min), because a patient tick legitimately holds a claim with no run for the whole deadline (#259 writes no run while every zone is held), and anything shorter mistakes patience for death.
Type: AFK
Wave: 2 · Severity: P2 · Finding: RC-3, `audit/2026-09-01-scheduler-engine-forensics.md` §8

## Problem

The cron-tick claim is at-most-once with no reclaim: `claimTick` is `INSERT … ON CONFLICT DO
NOTHING` on `(job_name, UTC-minute)` with no TTL, heartbeat, or reaper on the claim itself. If
the winning instance dies **after** the insert but **before** `DispatchRunService.admit` writes
the `dispatch_runs` row, nothing recovers: the dispatch reaper and the #286 collector key off
run/claim rows that were never written, and every other instance already no-oped with
`TICK_CLAIMED`. For minute-cadence sweeps that loses one tick (acceptable); for
`business-dispatch` (05:00 IST daily) it silently loses the day until a human presses Run Now.
This is the one crash point in the dispatch lattice with no recovery story.

## Root cause

`scheduling/cron-tick-claim.service.ts:51-71` (claim has no liveness signal);
`scheduling/dispatch-scheduler.service.ts:93` (the claim is burned before any durable evidence of
the run exists).

## Affected files / symbols

- `apps/backend/src/scheduling/dispatch-scheduler.service.ts` — `dispatchTick` ordering
- `apps/backend/src/scheduling/dispatch-run.service.ts` — reaper (`reapStaleDispatchRuns`) if the
  chosen design extends it
- `apps/backend/src/scheduling/cron-tick-claim.service.ts` / `cron-tick-claim.ts` — only if the
  chosen design adds claim-level liveness

## Intended behavior after fix

A crash at any point after the 05:00 fire leaves evidence some later pass acts on. Recommended
design (smallest surface, forensic report's first option): **for the dispatch tick only**, narrow
the gap to effectively zero by making the durable run evidence and the claim atomic — e.g. write
a minimal `dispatch_runs` row (or admission marker) in the same transaction as the tick claim, so
the existing reaper/collector machinery owns every subsequent crash. Alternative (wider): give
`cron_tick_claims` a heartbeat + reaper so an abandoned claim frees within minutes. Either is
acceptable; the issue is closed when AC1 holds. Do not change manual-run behavior (manual runs
are deliberately not tick-claimed).

## Implementation boundaries

- Dispatch tick only, unless the claim-heartbeat design is chosen (then it applies uniformly but
  must not change any sweep's single-fire semantics).
- Preserve #263's properties: one instance runs; losers no-op; clock-skew assumption unchanged.
- Do not weaken #259 admission (all-held still writes nothing *user-visible* — if a marker row is
  used it must be reaped/finalized, never left RUNNING).

## DB / API / frontend impact

DB: possibly one new nullable column or no change, depending on design (no data migration).
API/frontend: none.

## Dependencies

None hard. Touches `dispatch-run.service.ts` — sequence with #304/#305/#307 (same files), do not
run concurrently with them.

## Regression risks

- Double-run: whatever makes the evidence durable must not let two instances both dispatch —
  the per-zone claim partial unique remains the backstop; add a race test.
- Ledger noise: an empty-marker design must not create phantom ABORTED runs on healthy days.

## Tests required

- Crash simulation: claim taken, process "dies" before admission (inject a throw) → a later
  reaper/collector pass results in the day being dispatched (or the claim freed), asserted end
  to end.
- Barrier race: two instances, one crashes post-claim — exactly one eventual dispatch, no
  duplicate day plans (existing uniques asserted).
- Regression: `cron-tick-claims` and `dispatch-zone-claim-admission` suites stay green.

## Acceptance criteria

- [x] AC1 — no single crash point between cron fire and run finalization can silently cost the
      day; every one leaves state a documented janitor converts into a dispatch or a named
      failure. `recoverAbandonedDispatchTick`, wired into the 3-minute `dispatchReaperTick`, converts
      a claim with no dispatch-since into the same #286 marks the crash-after-admission path produces;
      the 5-minute collector does the dispatching, so #261's "the janitor does not dispatch" holds.
- [x] AC2 — no interleaving produces two live dispatch runs for one zone. No new code needed: recovery
      goes through `runForActiveZones` and the per-zone claim partial-unique is untouched; pinned by the
      existing `dispatch-zone-claim-admission` suite, still green.
- [x] AC3 — non-dispatch sweeps' tick semantics are unchanged. Only `business-dispatch` claims are
      inspected, so this holds by construction; asserted directly, and the wiring spec is green (two of
      its `DispatchRunService` stubs needed the new method — the widening is intended, so the tests
      moved, per #141's discipline).

## UI surfaces

n/a.

## Reference

n/a.

## Blocked by

— (sequence with 304/305/307 on shared files)
