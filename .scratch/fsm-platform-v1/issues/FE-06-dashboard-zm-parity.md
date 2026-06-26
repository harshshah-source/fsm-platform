# FE-06 — Zone Dashboard (ZM) parity

Status: ready-for-agent
Type: AFK · Frontend · Phase F1
Effort: M

> Governed by `DESIGN-SYSTEM.md` §8. Global DoD applies.

## What to build

Bring the ZM dashboard to parity with `01`: KPI `MetricStrip` (uptime % + counts), Action-Required as the
reference card grid (8 live card sources, data unchanged), Company/Plant overview `DataTable`, and the
Critical Work Queue rendered as `TicketCard`s with the existing assign action preserved.

## Dependencies

- FE-02, FE-03, FE-04, FE-05

## Acceptance criteria

- [ ] KPI MetricStrip (uptime % + open/critical counts) per `01`
- [ ] Action Required rendered as the reference card grid; card data unchanged (8 sources)
- [ ] Zone + Company/Plant overview as `DataTable` with `SLABadge`/`TierBadge`
- [ ] Critical Queue as `TicketCard`s; assign-SE picker action preserved

## Reusable components introduced

- `ActionRequiredCard` grid (composition only)

## Affected pages

- `DashboardHome` + `ActionRequiredPanel`, `ZoneOverviewTable`, `CompanyPlantTable`, `CriticalQueue` (**[RP]**)

## Reference

- `docs/ui/desktop/v2-reference/01-dashboard-zonal-manager.png`

## Verification

- `dashboard-home.test.tsx`, `dashboard-filters.test.tsx`, `dashboard-critical-action.test.tsx`, `dashboard-company-plant.test.tsx`, `critical-assign.test.tsx` green; Playwright ≈ `01`
