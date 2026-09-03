# 334 — Finish the acquisition order: the dispatch run and the cross-schedule moves
Status: done (2026-09-03) - see `docs/progress/334-acquisition-order-beyond-override-service.md`
Type: AFK
Wave: 4 · Severity: P3 · Follow-up from #327 (RC-12), `audit/2026-09-01-scheduler-engine-forensics.md` §8

## Problem
#327 gave `override.service.ts` one documented acquisition order —
`tickets → work_schedules → plant_batch_assignments → batch_assignment_tickets` — and mapped a residual
40P01 to each door's existing conflict outcome so nothing 500s. Two residues were named there rather
than fixed, because both lie outside that issue's stated boundary (`override.service.ts` internals only):

1. **The dispatch run writes `work_schedules` before `tickets`.** `batch-assignment.service.ts`
   creates/finds the SE's schedule (`dispatchForSe`, the `byPlant.size > 0` block) and only then runs
   its guarded `tickets.updateMany`. A manual assign holding a ticket row while waiting on that
   schedule's partial unique, against a dispatch holding the schedule and waiting on the ticket, is a
   cycle. It is narrow — it needs the SE's *first* schedule of the day to be created by both writers at
   once — but the 05:00 run and an eager manager occupy exactly that window.
2. **Cross-schedule moves have no order between source and destination.** `moveTickets` and `swapSe`
   take the destination schedule (via `ensureSchedule`) and then stamp the source (`flagOverridden`,
   and `swapSe`'s inline `workSchedule.updateMany`). Two moves in opposite directions between the same
   pair of engineers can cycle.

Neither is a 500 today — #327's mapping answers both — but a mapped deadlock is still a refused
operation the operator has to repeat.

## Root cause
The order was established one file at a time; the engine and the two-schedule movers were never brought
into it.

## Affected files / symbols
`apps/backend/src/scheduling/batch-assignment.service.ts` — `dispatchForSe`.
`apps/backend/src/scheduling/override.service.ts` — `moveTickets`, `swapSe`.

## Intended behavior after fix
- `dispatchForSe` takes the ticket rows before creating or attaching to the schedule, or the manual
  doors take the schedule first — **one** decision, recorded beside #327's order note, not two files
  each choosing locally. Note #306's rule ("the ticket write comes FIRST, and it is guarded") is about
  the ticket-vs-batch pair and does not by itself settle ticket-vs-schedule.
- A transaction that touches two schedules locks them in a deterministic order (ascending
  `schedule_id` is the obvious one) so two movers queue instead of cycling.
- #327's `isDeadlock` mappings stay as the backstop; this issue is about not needing them.

## Implementation boundaries
No API shape change; no change to the dispatch run's skip/claim vocabulary (#306/#307) or to
`retryOnceOnUniqueViolation`'s role.

## DB / API / frontend impact
None expected. No migration.

## Dependencies
After #327 (done — `docs/progress/327-assignment-write-path-ordering.md` owns the order and the
measured 40P01 shape).

## Regression risks
`dispatchForSe`'s per-SE transaction already carries the zone + engineer advisory locks (#262/#304) and
#307's one-shot P2002 retry; moving the schedule write must not reorder those or widen the RC-8 window.

## Tests required
Barrier: manual assign vs `dispatchForSe` on one ticket where the SE has no schedule for the day → no
40P01 on either side. Two opposite-direction `SWAP_SE`/`REASSIGN` moves between one pair of engineers →
no 40P01. `test/assignment-write-path-ordering.e2e-spec.ts`'s hooked-client harness stages both.

## Acceptance criteria
- [x] AC1 — a manual assign concurrent with the dispatch run cannot deadlock, and the recorded order
      says which of the two moved and why.
- [x] AC2 — two cross-schedule moves in opposite directions cannot deadlock.

## UI surfaces
n/a.

## Reference
n/a.

## Blocked by
327 (done).
