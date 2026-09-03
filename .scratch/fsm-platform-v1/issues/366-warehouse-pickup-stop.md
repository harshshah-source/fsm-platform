# 366 — Zone Warehouse pickup stop on the Day Plan
Status: ready-for-human
Type: HITL (design stop) then AFK
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
- [ ] AC1 — a plan whose tickets have SHIPPED-not-RECEIVED component requests carries exactly one
      pickup stop, first; no pickup stop otherwise; the admin schedule detail shows it.

## Verification

`test/day-plan-query.e2e-spec.ts`: with and without a SHIPPED request on a planned ticket; admin
test for the schedule detail once the design exists.

## UI surfaces

Admin: schedule detail (modified — pickup stop rendered). Mobile: excluded.

## Reference

No v2 image and no approved design exists — the PRD carries flow text only. This is a **design
stop** for the admin/mobile rendering: per the plan, produce one under
`docs/ui/desktop/approved-designs/` before building the rendering. The slice flips to
`ready-for-agent` once that design is approved.

## Blocked by
- #352 — field component wire contract (the `component_requests` rows this stop is derived from).
- Design stop — an approved design under `docs/ui/desktop/approved-designs/` (HITL).

## Absorbs / supersedes
- survey ids: SCH-03.
- existing issues: none.
