# 100 — Batch dispatch: transactional, idempotent, recommendation-consuming
Status: done
Type: AFK

> **Done (2026-07-08, TDD).** `BatchAssignmentService.dispatchForZone` is now safe to invoke twice and
> impossible to double-dispatch:
> 1. **Transaction per zone** — the whole dispatch (all SEs) runs in one `$transaction`; a mid-loop
>    failure rolls back every partial write (no orphaned schedule/batch, no half-set `assignmentState`).
>    The notifier fires only AFTER commit (a rolled-back plan never announces "Day Plan is live").
> 2. **Consume recommendations** — dispatched recs flip `SUGGESTED → DISPATCHED` in the same tx, so a
>    re-invoke with no new recs is a clean `{0,0,0}` no-op.
> 3. **DB backstops (migration `20260708120000`)** — two partial uniques:
>    `recommendations_one_suggested_per_ticket (ticket_id) WHERE status='SUGGESTED'` and
>    `work_schedules_one_active_per_se_zone_day (se_id, zone_id, date_from) WHERE status='ACTIVE'`.
>    **Design change vs the spec:** the work_schedules key includes **`zone_id`** — the spec's
>    `(se_id, date_from)` would reject legitimate floating-SE / cross-zone day-plans (an SE may hold one
>    plan per zone per day; per-zone dispatch + cross-zone approve both rely on that). The requested
>    third index `batch_assignment_tickets(batch_id, ticket_id)` was **not added** — the existing
>    `batch_assignment_tickets_one_active_per_ticket (ticket_id) WHERE removed_at IS NULL` already
>    subsumes it. A P2002 on either new unique is caught and returned as the graceful no-op, not a 500.
> 4. **Per-zone advisory lock** — `pg_try_advisory_xact_lock(hashtext('dispatch_zone_'||zoneId))` at the
>    top of the tx (SnapshotRunService idiom) serializes concurrent dispatches; the loser degrades to
>    `{0,0,0}`.
>
> One existing fixture updated: `zm-performance-aggregation.e2e-spec.ts` `autoBatch` created two ACTIVE
> schedules for the same (se, zone, day) — a state the new unique forbids; fixed to distinct days (the
> zone denominator counts `plant_batch_assignments` by `created_at`, so the count is unchanged).
>
> **Tests (4 new specs):** `dispatch-idempotent` (consume/no-op), `dispatch-transactional` (rollback via
> a staged mid-loop P2002), `dispatch-uniques` (both backstops reject dups; cross-zone allowed; consumed
> row frees a new SUGGESTED), `dispatch-concurrent` (Promise.all → one plan, neither throws). Full
> backend suite **920 pass / 5 skip**, tsc clean, migration applied cleanly. The `transitionOrConflict`
> helper mentioned below is left to **#101** (this issue's lock/consume/tx satisfied #100's ACs without
> it). Unblocks **#113** (daily dispatch scheduler).

> Source: `docs/audits/2026-07-03-backend-production-readiness-audit.md` — CRITICAL #2 (+ the dispatch
> legs of HIGH #11). Verified still-open 2026-07-07: `scheduling/batch-assignment.service.ts`
> `dispatchForZone` reads `recommendation.findMany({ status: 'SUGGESTED' })`, does bare sequential
> `workSchedule.create` / `plantBatchAssignment.create` / `batchAssignmentTicket.create` /
> `ticket.update` with **no `$transaction`**, and **no code anywhere flips a recommendation off
> `SUGGESTED`** (grep-confirmed). Schema has no `@@unique` backstop on `recommendations(ticketId)`,
> `work_schedules(seId, dateFrom)`, or `batch_assignment_tickets(batchId, ticketId)`.

## What to build

Make Recommender → Day-Plan dispatch safe to invoke twice (retry, double-click, second instance)
and impossible to double-dispatch the same SUGGESTED set.

1. **Transaction per unit.** Wrap each SE's day-plan write (WorkSchedule → PlantBatchAssignment →
   BatchAssignmentTicket → ticket `assignmentState` update) in a `$transaction`, so a mid-loop crash
   leaves no ticket in an active batch while UNASSIGNED.
2. **Consume recommendations.** Flip each dispatched recommendation from `SUGGESTED` to a consumed
   status inside the same transaction, so a re-invoke no longer re-reads and re-dispatches it.
3. **DB backstops.** Add partial uniques — `recommendations(ticket_id) WHERE status='SUGGESTED'`,
   `work_schedules(se_id, date_from) WHERE status='ACTIVE'`, `batch_assignment_tickets(batch_id,
   ticket_id)` — and handle P2002 as the designed race-loser outcome (not a raw 500), the pattern
   `SnapshotRunService` already uses.
4. **Serialize concurrent runs.** An advisory lock (per zone) around the dispatch, matching the
   existing `SnapshotRunService` idiom, so two concurrent recommender/dispatch runs can't suggest one
   ticket to two SEs.

## Acceptance criteria

- [x] `dispatchForZone` runs each SE's writes in a `$transaction`; a forced failure mid-loop rolls back that SE's partial writes (no orphaned batch tickets, no half-updated `assignmentState`).
- [x] Dispatched recommendations move `SUGGESTED` → consumed in the same tx; a second `dispatchForZone` with no new recommendations is a clean no-op (dispatches 0).
- [x] Migration adds the partial uniques above; the existing suite stays green. *(Two added, not three — the batch_assignment_tickets one already existed and is stronger.)*
- [x] A duplicate dispatch that races the uniques surfaces as the graceful outcome, not a 500.
- [x] Advisory lock serializes concurrent dispatches for a zone.
- [x] New concurrency test: two `dispatchForZone` calls via `Promise.all` on the same SUGGESTED set produce exactly one ACTIVE WorkSchedule and one set of batch tickets.

## UI surfaces
n/a (backend)

## Reference
n/a

## Blocked by
None — can start immediately. The `transitionOrConflict`/guarded-update helper introduced here (or in #101) is shared with #101.
