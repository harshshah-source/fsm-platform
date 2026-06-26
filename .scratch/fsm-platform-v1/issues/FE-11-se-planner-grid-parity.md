# FE-11 — SE Planner grid parity

Status: ready-for-agent
Type: AFK · Frontend · Phase F3
Effort: M

> Governed by `DESIGN-SYSTEM.md` §8. Global DoD applies.

## What to build

Bring `PlannerPage` to parity with `16`: a `PlannerGrid` (engineer rows × coverage/day columns with
plant-visit intent cells), KPI counts strip. Existing CRUD + recommender-bias calls unchanged.

## Dependencies

- FE-03, FE-04

## Acceptance criteria

- [ ] `PlannerGrid` matches `16` (coverage column, engineer rows, day cells, KPI counts)
- [ ] Create/edit/remove planner intent uses existing API; optimistic update preserved
- [ ] Engineer display names + coverage type shown

## Reusable components introduced

- `PlannerGrid`

## Affected pages

- `PlannerPage` (**[RP]**)

## Reference

- `docs/ui/desktop/v2-reference/16-se-planner.png`

## Verification

- `planner-grid.test.tsx` green; Playwright ≈ `16`
