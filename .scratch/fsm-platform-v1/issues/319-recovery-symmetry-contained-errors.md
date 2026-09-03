# 319 — Same-day recovery for zones lost to contained errors
Status: done
Type: AFK
Wave: 3 · Severity: P3 · Finding: AR-13, `audit/2026-09-01-scheduler-engine-forensics.md` §7

## Problem

Recovery is asymmetric: a zone lost to **process death** gets a `dispatch_zone_recoveries` mark
(written by the reaper, `dispatch-run.service.ts:538-540`) and a bounded same-day re-dispatch
(#286); a zone lost to a **contained in-process error** (a throw inside `execute`, finalized by
`releaseStrandedClaims` :770-782, or a per-zone `error`) is recorded on the ledger but never
re-dispatched automatically — the worse failure gets the better recovery.

## Root cause

#286 deliberately scoped marks to the reaper; the contained-error path predates it and was never
revisited.

## Affected files / symbols

- `apps/backend/src/scheduling/dispatch-run.service.ts` — the per-zone error finalize and
  `releaseStrandedClaims` write the same `markZonesForRecovery` the reaper uses

## Intended behavior after fix

A zone whose claim finalizes ERROR (in-run exception or stranded-claim release) is marked in
`dispatch_zone_recoveries` under the same (zone, operating-day) budget, cutoff and
attempt-carrying rules as a reaped zone — the #286 collector then owns it with no new machinery.
A zone that finalized DONE or CONTENDED is never marked (busy is not broken — #286's own rule).

## Implementation boundaries

- Reuse `markZonesForRecovery` verbatim; no collector changes; no new state members; budgets and
  cutoff untouched.

## DB / API / frontend impact

DB: more rows in an existing table. API: the existing `recovery` field on `/dispatch/today`
starts covering these cases. Frontend: none (the cockpit already renders it).

## Dependencies

After the dispatch-file sequence (#303–#307) to avoid concurrent edits. Semantically independent.

## Regression risks

- Double-marking (reaper + error path) — the `@@unique(zoneId, businessDate)` and the re-arm
  rules already handle it; pin with a test.
- A deterministic per-zone error (bad data) would burn the 3-attempt budget — acceptable and
  bounded by design; the mark's `last_error` names it.

## Tests required

- e2e: injected per-zone error → mark PENDING → collector re-dispatches within budget;
  EXHAUSTED after repeated failure; DONE/CONTENDED zones never marked.

## Acceptance criteria

- [x] AC1 — any zone that lost its day to an error has the same bounded recovery a crashed zone
      has.
- [x] AC2 — attempt budgets/cutoff semantics are unchanged and shared.

## Outcome — DONE 2026-09-02
Report: `docs/progress/319-errored-zone-same-day-recovery.md`.

**AC1.** What marks is now **a claim finalizing ERROR**, not the cause of it — both losses end at the
same `dispatch_run_zones` row in the same state. Two writers gained the mark: `processZone` (a
contained per-zone throw, or a whole-zone `skipReason`) and `releaseStrandedClaims` (a claim still open
as the run unwinds — the half the reaper structurally cannot reach, because the process is alive and
finalizing itself). Both mark **before** finalizing/freeing, which is the reaper's own ordering rule: a
death in the gap leaves the claim RUNNING, exactly the population the next reap pass finds.
`releaseStrandedClaims` also had to start reading (a blind `updateMany` cannot name what it frees) and
now takes the run's `now`, so a mark written while unwinding lands on the operating day the run was
dispatching rather than on the wall clock at unwind.

**AC2.** `markZonesForRecovery` reused verbatim → one row, one budget, one cutoff per (zone, day)
however many ways the zone was lost. No new state member, no collector change, no migration.
**The interaction that needed checking rather than assuming:** the collector re-dispatches through
`runForActiveZones`, so a failing recovery run now re-marks the zone *from inside the collector's own
attempt*. It holds because the mark write never touches `attempts`, so the collector's
`{ state: 'PENDING', attempts: <seen> }` guard still matches and the budget spends exactly once per
attempt. Pinned by a test rather than left to inspection. EXHAUSTED/EXPIRED stay non-re-armable, so an
error arriving after the budget is spent cannot restart the loop — asserted through the new door too.

**The negative rules are held by construction, and pinned:** a DONE zone is never marked, and a
CONTENDED row is written by `admit`, which neither new writer goes through — so #286's "busy is not
broken" cannot be bent here by accident.

**UI (the issue's "coverage widens").** The widening made the cockpit copy false: it said "this zone's
dispatch run **died**", and for both new cases the run did not die — it finished and reported the loss.
An operator would have gone hunting for a crashed process that never existed. The headline now says the
zone **lost its dispatch run** and leaves the cause to `last_error`; the backend `TodayRecovery`
docblock says the same, so both ends of the field agree. New admin test asserts the notice never says
"died".

**Tests.** `test/dispatch-errored-zone-recovery.e2e-spec.ts` (8) — 5 red first (no mark row at all;
nothing to collect; a correctly-freed claim with no mark; nothing to attempt; nothing to expire), 3
green throughout as controls. The unwind case is staged by making the **successful** finalize throw,
keyed on `data.status === 'DONE'` because the reaper and the release write the same delegate with
`status: 'ERROR'`. Full backend suite **452 files / 2,414 passed / 5 skipped**; the 40-file dispatch
surface green; admin **119 files / 830 tests**; `tsc --noEmit` clean in both apps.

## UI surfaces

Admin: cockpit recovery notice (existing — coverage widens).

## Reference

n/a.

## Blocked by

303–307 (file sequence only)
