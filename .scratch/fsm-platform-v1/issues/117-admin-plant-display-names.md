# 117 — Admin plant display names: prefix→full-name label helper + `<PlantName>` component
Status: done (2026-07-12)
Type: admin FE, presentation-only

> Source: filed 2026-07-12 to own a working-tree slice found during the doc-consolidation session
> (per the CLAUDE.md convention: no unfiled WIP). AutoPlant supplies plant identifiers as short
> codes (`ACP-9106`) and does not carry full plant names; that prefix→name mapping is business
> knowledge (see the plant families in `docs/audits/unzoned-plants-2026-07-07.md`). Every admin
> surface previously rendered the raw code.

## Scope

- `apps/admin/src/lib/plantNames.ts` — canonical `PLANT_FULL_NAME` prefix map (11 cement plants) +
  `resolvePlantName` (single resolution point, never throws) + `formatPlantDisplayName`
  (`ACP-9106` → `ARASMETA CEMENT PLANT (ACP-9106)`; unmapped/name-style ids pass through verbatim;
  nullish/blank → `''`). String form for CSV cells / tooltips / aria labels.
- `apps/admin/src/components/domain/PlantName.tsx` — the single UI presentation (`stacked` default:
  name + muted mono code line; `inline` variant for tight flex rows); native `title` tooltip always
  carries `FULL NAME (CODE)`.
- Wired into 8 pages: dashboard CompanyPlantTable (rows + drill-down header + CSV) / CriticalQueue /
  EscalationQueueList, PlannerPage, VehicleUnavailabilityPage, DeviceDetailPage,
  ScheduleDetailPage — display-only.

## Invariant

`plantId` remains the key/filter/group/route everywhere; only rendered labels change. No API or
backend change; adding a plant = one map entry.

## Acceptance criteria

- [x] Mapped code renders full name with original code preserved; unmapped/name-style ids verbatim.
- [x] Nullish/blank input never throws and yields `''` (callers own empty states).
- [x] Unit tests for helper + component (`apps/admin/test/plant-names.test.ts`,
      `plant-name-component.test.tsx`); admin suite + `tsc` green.
