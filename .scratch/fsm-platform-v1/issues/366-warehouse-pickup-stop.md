# 366 — Zone Warehouse pickup stop on the Day Plan
Status: done 2026-09-04 — report docs/progress/366-warehouse-pickup-stop.md
Type: HITL (design stop, cleared 2026-09-03 by #369) then AFK
Wave: 5 · Severity: P3 · Found by: module-gaps survey 2026-09-02, verified against the working tree 2026-09-03 (`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4)

## Problem

`DayPlanStop` (`packages/shared/src/index.ts:571-578`) has no stop kind; the day-plan query's
docblock explicitly defers the pickup step (`scheduling/day-plan-query.service.ts:15-16`). An SE
whose ticket has a SHIPPED part therefore gets no warehouse stop on their plan and must remember
the pickup themselves.

## Current code

- `packages/shared/src/index.ts:571-578` — `DayPlanStop` without a `kind`.
- `apps/backend/src/scheduling/day-plan-query.service.ts:15-16` — pickup step deferred in the
  docblock.
- `apps/backend/src/scheduling/batch-assignment.service.ts` — emits plant stops only.
- `schema.prisma` — no pickup flag/row on the schedule.

## What to build

- `packages/shared` — `DayPlanStop.kind: 'PLANT' | 'WAREHOUSE_PICKUP'`.
- `schema.prisma` — pickup flag/row on the schedule + migration.
- `day-plan-query.service.ts` — return the pickup stop.
- `batch-assignment.service.ts` — emit stop 0 (`WAREHOUSE_PICKUP`) when a SHIPPED-not-RECEIVED
  component request exists for a ticket on the plan.
- Admin schedule detail shows the pickup stop.
- `test/day-plan-query.e2e-spec.ts`.
- Mobile rendering is excluded; the rendering (admin and mobile) is behind the design stop below.

## Acceptance criteria
- [x] AC1 — a plan whose tickets have SHIPPED-not-RECEIVED component requests carries exactly one
      pickup stop, first; no pickup stop otherwise; the admin schedule detail shows it.

**No schema change was needed** — the premise of "pickup flag/row on the schedule + migration" was
wrong. The stop is derived at read time from `component_request.status = 'SHIPPED'` (which already
means shipped-and-not-yet-received) over the plan's live tickets, because "stop 0 appears only when
it is real" is a present-tense fact: a part shipped after dispatch must appear, and a confirmed
receipt must make the stop vanish. `schema.prisma` is untouched and no migration exists. Reasoning
in full in the report.

## Verification

`test/day-plan-query.e2e-spec.ts`: with and without a SHIPPED request on a planned ticket; admin
test for the schedule detail once the design exists.

## UI surfaces

Admin: schedule detail (modified — pickup stop rendered). Mobile: excluded.

## Reference

**Approved 2026-09-03**: `docs/ui/desktop/approved-designs/warehouse-pickup-stop.html` is the
authoritative reference for the pickup stop, with the same standing as a v2 image;
`12-batch-schedule-review.png` governs the surrounding schedule-detail chrome. The decision record
is `369-decision-warehouse-pickup-stop.md`.

## Blocked by
- ~~#352 — field component wire contract~~ (landed; the `component_requests` rows this stop is
  derived from).
- ~~Design stop~~ — cleared 2026-09-03 (#369).

## Absorbs / supersedes
- survey ids: SCH-03.
- existing issues: none.
