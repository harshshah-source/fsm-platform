# 73 — Warehouse stock read + Low-Stock / Fulfillment-SLA KPIs

Status: done (2026-07-01)
Type: HITL (schema decision) · Backend + Frontend
Origin: FE-17 follow-up (2026-06-26) — the Warehouse Stock table + KPIs had no backend source.

## Background & HITL decision

FE-17 shipped the WM dashboard with the **Warehouse Stock** table and the **Low-Stock** + **Fulfillment-SLA**
KPIs gated, because the inventory model had **no warehouse-stock table**: only `component_master`
(SKU catalog, no quantities), `se_van_stock` (per-SE), and the SE-keyed `inventory_transactions` ledger.
Warehouse on-hand was never modelled (Issue 21 deferred it). Ratified 2026-07-01: **add a real
WM-managed zone-warehouse stock table** (vs. shipping only the derivable KPI or a seed-only table).

## What was built

- **Schema:** `zone_warehouse_stock` (`zone_id`×`component_id` unique; `on_hand`, `reserved`,
  `low_stock_threshold`), migration `20260701000000_add_zone_warehouse_stock` (additive, no drift).
- **Backend (`/api/inventory/warehouse-stock`):**
  - `GET` — per-zone SKU levels (WM/ZM/CSM/OH; ZM zone-scoped). `available` = on_hand − reserved;
    `lowStock` = available ≤ threshold; carries zone + component names.
  - `PATCH` — audited set/adjust of on_hand/reserved/threshold (WM/OH), upsert per (zone, component),
    `WAREHOUSE_STOCK_SET` audit row.
  - `GET .../fulfillment-sla` — % of RECEIVED component requests fulfilled within a 7-day window + avg
    fulfilment hours + open-request count, derived from `component_request` created→received timings.
  - `WarehouseStockService`; 5 e2e (set→read-back w/ derived available+low-stock, audit row, KPI shape,
    ZM zone-exclusion, SE 403).
- **Admin (FE-17 fill):** `WarehouseDashboard` Warehouse-Stock `DataTable` + Low-Stock-SKUs KPI +
  Fulfillment-SLA KPI (all previously gated) + a WM/OH adjust `Modal` (on-hand/reserved/threshold). 2 tests.

## Acceptance criteria

- [x] Zone-warehouse stock read (per-SKU on-hand/reserved/available + low-stock threshold), zone-scoped.
- [x] WM/OH audited set/adjust.
- [x] Fulfillment-SLA KPI from real component-request data.
- [x] FE-17 stock table + Low-Stock + Fulfillment KPIs filled (no fabricated figures).

## Deferred → #95

The **v1 business rule is manual**: the Warehouse Manager sets on-hand. The **automated Mother→Zone
replenishment flow** and **auto-decrementing warehouse on-hand on ticket consumption** (CONTEXT
"eventually decremented") are **not** built — filed as **#95**.
