# FE-17 — Warehouse persona dashboard

Status: done (Warehouse Stock table → #73)
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

- [~] WM dashboard matches `05` (KPI + request queue + stock table + shadow-use panel) — KPI + request
  queue + shadow-use panel built; **stock table** chrome + gated placeholder (no read endpoint → #73)
- [x] Reuses existing inventory/component-request data; no new endpoints
- [x] Nav scoped to WM links (Dashboard/Component Requests/Shadow Use/Warehouse Stock/Help) — already
  WM-scoped in the shell (FE-02); unchanged

## Outcome (done with follow-up — presentation-only, FE-17)

`DashboardHome` is now a thin role selector: `WAREHOUSE_MANAGER` → new `WarehouseDashboard`; every other
role → the extracted `ManagerDashboard` (which keeps the FE-06/07 ZM/Central/Pan-India selection). This
guarantees the manager-scoped dashboard endpoints are **never called for a WM**.

`WarehouseDashboard` ("Zone Warehouse Fulfillment", reference 05) composes the existing WM aggregations
(no new endpoints): a KPI `MetricStrip` (Open Requests / Tickets Blocked + gated Low-Stock /
Fulfillment-SLA), a Component-Request-Queue `DataTable` (link to the full FE-15 queue), and a Shadow-Use
Reconciliation `DataTable`.

**Documented omission → #73:** the reference's Warehouse Stock table and Low-Stock / Fulfillment-SLA KPIs
have no backend read endpoint; the stock `SectionCard` renders the chrome with an `EmptyState` note and
those KPIs show `—`, rather than fabricated stock figures. New `dashboard-warehouse.test.tsx` (2 cases);
all prior dashboard tests green. Verified: admin `tsc --noEmit` clean · vitest **100/100** · `vite build`
OK.

## Reusable components introduced

- `WarehouseStockTable` (composition over `DataTable`)

## Affected pages

- `DashboardHome` (Warehouse variant; **[N] shell**)

## Reference

- `docs/ui/desktop/v2-reference/05-dashboard-warehouse.png`

## Verification

- new WM dashboard test; Playwright ≈ `05`
