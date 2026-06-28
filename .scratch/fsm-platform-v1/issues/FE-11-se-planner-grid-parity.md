# FE-11 — SE Planner grid parity

Status: done
Type: AFK · Frontend · Phase F3
Effort: M

> Governed by `DESIGN-SYSTEM.md` §8. Global DoD applies.

## What to build

Bring `PlannerPage` to parity with `16`: a `PlannerGrid` (engineer rows × coverage/day columns with
plant-visit intent cells), KPI counts strip. Existing CRUD + recommender-bias calls unchanged.

## Dependencies

- FE-03, FE-04

## Acceptance criteria

- [x] `PlannerGrid` matches `16` (coverage column, engineer rows, day cells, KPI counts)
- [x] Create/edit/remove planner intent uses existing API; optimistic update preserved
- [x] Engineer display names + coverage type shown

## Outcome (done — presentation-only, FE-11)

`PlannerPage` re-skinned onto `PageHeader` ("SE Planner" + `DateRangeChips`) + a KPI `MetricStrip`
(Engineers / Plant Intents / Planned SEs / Window) + a **Coverage** column (`coverageType` chip), with
the grid wrapped in the canonical card/table chrome (caps headers, token borders, `Badge` intent chips
+ batch pills).

The planner grid is unique (per-cell drag/drop, multi-intent SE×day cells, day columns) so the bespoke
`<table>` is preserved and re-skinned in place — the flat `DataTable` cannot express it. Every selector +
behaviour is preserved: `SE Planner grid` aria-label, `cell-*` / `intent-*` / `batch-*` /
`batch-status-*` / `plant-drag-source` test ids, the `Plant to assign` picker, the `Add plant to … on …`
and `Remove …` button labels, the `text/plant-id` drag dataTransfer, and the POST/DELETE `/api/planner`
CRUD with refetch. Verified: admin `tsc --noEmit` clean · vitest **98/98** · `vite build` OK.

## Reusable components introduced

- `PlannerGrid`

## Affected pages

- `PlannerPage` (**[RP]**)

## Reference

- `docs/ui/desktop/v2-reference/16-se-planner.png`

## Verification

- `planner-grid.test.tsx` green; Playwright ≈ `16`
