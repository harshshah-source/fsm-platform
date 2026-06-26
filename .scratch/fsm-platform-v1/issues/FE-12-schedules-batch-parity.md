# FE-12 — Schedules + Schedule Detail parity

Status: ready-for-agent
Type: AFK · Frontend · Phase F3
Effort: M

> Governed by `DESIGN-SYSTEM.md` §8/§9. Global DoD applies.

## What to build

Bring `SchedulesPage` + `ScheduleDetailPage` to parity with `12`: KPI `MetricStrip`, left SE list with
plant-grouped assigned `TicketCard`s (AUTO badge), right selected-SE day-plan with stop cards + position/
shift controls + PARTIAL/CRITICAL badges. **Omit the "Approve" gate** (Decision §7 removed it — render
the `AUTO-ASSIGNED` framing instead). Override flow preserved.

## Dependencies

- FE-03, FE-04

## Acceptance criteria

- [ ] Batch board matches `12` (SE list + selected-SE day plan), minus the Approve gate (documented deviation)
- [ ] MetricStrip + per-ticket card badges (tier/bucket/PARTIAL/CRITICAL)
- [ ] ZM override / reorder actions preserved (existing API + selectors)

## Reusable components introduced

- `DayPlanBoard`, `ScheduleStopCard` (composition)

## Affected pages

- `SchedulesPage`, `ScheduleDetailPage` (**[RP]**)

## Reference

- `docs/ui/desktop/v2-reference/12-batch-schedule-review.png`

## Verification

- `schedules-list.test.tsx`, `schedule-detail.test.tsx`, `schedule-override.test.tsx` green; Playwright ≈ `12`
