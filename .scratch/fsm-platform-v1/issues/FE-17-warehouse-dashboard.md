# FE-17 — Warehouse persona dashboard

Status: ready-for-agent
Type: AFK · Frontend · Phase F4
Effort: S/M

> Governed by `DESIGN-SYSTEM.md` §8. Global DoD applies.

## What to build

The Warehouse-Manager dashboard variant matching `05` "Zone Warehouse Fulfillment": KPI strip (open
requests / tickets blocked / low stock / fulfillment SLA), Component Request Queue cards (Mark-Received),
Warehouse Stock `DataTable`, Shadow-Use reconciliation panel. Reuses existing inventory/component
aggregations; nav already WM-scoped (FE-02).

## Dependencies

- FE-07 (variant scaffolding), FE-15

## Acceptance criteria

- [ ] WM dashboard matches `05` (KPI + request queue + stock table + shadow-use panel)
- [ ] Reuses existing inventory/component-request data; no new endpoints
- [ ] Nav scoped to WM links (Dashboard/Component Requests/Shadow Use/Warehouse Stock/Help)

## Reusable components introduced

- `WarehouseStockTable` (composition over `DataTable`)

## Affected pages

- `DashboardHome` (Warehouse variant; **[N] shell**)

## Reference

- `docs/ui/desktop/v2-reference/05-dashboard-warehouse.png`

## Verification

- new WM dashboard test; Playwright ≈ `05`
