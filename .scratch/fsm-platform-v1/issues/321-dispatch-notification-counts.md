# 321 — Day-plan notification counts agree (stops vs tickets)
Status: done (2026-09-03) - see `docs/progress/321-dispatch-notification-counts.md`
Type: AFK
Wave: 4 · Severity: P3 · Finding: CB-8, `audit/2026-09-01-scheduler-engine-forensics.md` §6

## Problem
On a same-day append, the SE's day-plan-dispatched notification mixes a **cumulative** stop count
with an **incremental** ticket count (3 existing stops + 1 new stop / 2 new tickets notifies
`stops=4, tickets=2`).

## Root cause
`batch-assignment.service.ts:244` continues `stopSequence` from the plan's existing max; `:292`
passes that running total as `stops` while `tickets` counts only this run's rows.

## Affected files / symbols
`apps/backend/src/scheduling/batch-assignment.service.ts` (`dispatchForSe` outbox call);
read-only: `day-plan-notifier.ts:60-67`.

## Intended behavior after fix
Both figures use one basis. Decide once and comment it: incremental ("N stops / M tickets added")
matches the append event; cumulative matches "your day now holds". Either is acceptable — mixed
is not.

## Implementation boundaries
The payload computation only; no notifier/outbox mechanics, no schema.

## DB / API / frontend impact
Notification metadata only.

## Dependencies
Sequence after the #303–#307 chain (same file).

## Regression risks
None beyond the payload; the fresh-plan case must stay byte-identical (existing
batch-dispatch-notify e2e).

## Tests required
e2e append case: an SE with an existing plan receives figures on the chosen single basis; fresh
plan unchanged.

## Acceptance criteria
- [x] AC1 — stops and tickets in one notification share one basis, stated in a comment.
- [x] AC2 — fresh-plan notifications unchanged.

## UI surfaces
n/a (push metadata).

## Reference
n/a.

## Blocked by
303–307 (file sequence only)
