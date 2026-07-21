# 135 — Company / Plant Overview rework: tier + plant columns, plant sub-table, fleet uptime

Status: done
Type: AFK

> **Done 2026-07-20** — `CompanyPlantTable` reworked: Tier + Plants promoted to their own columns;
> plant sub-table headers now Company·Plant·Inactive/Total·SLA Spread·Fleet Uptime %; the "Devices"
> column / "View devices" button removed — the whole plant row toggles the device sub-table
> (`aria-expanded`, keyboard-operable). Fleet Uptime % joined from `/reports/fleet-uptime?groupBy=plant`
> via a new `plantUptime` map threaded through `ManagerDashboard` → OH/ZM/CSM dashboards, `—` when
> absent. Export gains Plants + Fleet Uptime %. Tests: `company-plant-overview-rework.test` (4/4) +
> updated `dashboard-company-plant`/`dashboard-filters` for the new contract. Uncommitted.

> Operator ask (2026-07-20), building on the Issue-122 Company/Plant Overview. Three changes to the
> table on the ZM / OH / CSM dashboards (`apps/admin/src/pages/dashboard/CompanyPlantTable.tsx`).

## Changes

### 1. Tier + plant-count as columns (not inline badges)
Today the company row shows `TierBadge` and "N plants" inline next to the company name. Promote both
to their own **Tier** and **Plants** columns (matches reference 04, which has a PLANTS column).

- [ ] Company row renders a dedicated Tier column (SILVER / GOLD / PLATINUM badge) and a Plants column
      (plant count); the name cell keeps only the name + expander chevron.

### 2. Company → plant sub-table with the specified headers
Clicking a company row already expands its plants. Reshape the plant sub-table columns to exactly:
**Company name · Plant · Inactive / Total · SLA buckets · Fleet Uptime %**. Remove the standalone
**Devices** column (the "View devices" affordance). Instead, **clicking a plant row** opens its device
sub-table (the existing `OpenDeviceTickets` drill-down) — the whole row is the toggle, not a button.

- [ ] Plant sub-table headers are exactly: Company name, Plant, Inactive/Total, SLA buckets (the
      existing `SlaSpread` chip row), Fleet Uptime %.
- [ ] The **Devices** column / "View devices" button is removed; clicking anywhere on a plant row
      toggles its device sub-table (existing `OpenDeviceTickets`, unchanged) with `aria-expanded`.
- [ ] `Inactive %` column: fold into the same layout (keep it if it fits the "Inactive/Total" intent,
      else drop — operator listed Inactive/Total, not Inactive %; default: drop the separate % column
      to match the requested header list).

### 3. Fleet Uptime % per plant
Source per-plant uptime from the monthly fleet-uptime report (`GET /reports/fleet-uptime?groupBy=plant`,
existing endpoint). Join by `plantId` into the table rows.

- [ ] Fleet Uptime % column shows the plant's current-month uptime; **shows `—` when absent** (the
      monthly summary is empty until an OH recompute runs — decided with operator 2026-07-20). No fake
      values, no crash on an empty report.
- [ ] The join is resilient to an older backend / missing report (column degrades to all `—`).

### 4. Sort / filter / download (already present — verify + keep)
The header row already has universal search, an assignment filter, an inactivity sort, and a
CSV/Excel/PDF `ExportMenu`. Keep these; extend the download to include the new Tier / Plants / Fleet
Uptime columns.

- [ ] Sort, filter, and download controls remain at the top of the company table; the export body
      includes Tier, Plants, and Fleet Uptime %.

## Acceptance criteria (rollup)

- [ ] Company rows: Tier + Plants columns; plant sub-table matches the exact requested header set;
      plant-row click opens the device sub-table; Fleet Uptime % wired with `—` fallback; export
      updated. Existing test ids preserved where the vitest suite asserts them (`plant-inactive-total`,
      `bucket-<B>`, `plant-summary-*`, assignment badges).
- [ ] Reference `docs/ui/desktop/v2-reference/04-dashboard-operations-head.png` before building
      (surfacing rule); keep the black table-header band + SLA chip styling. Do not redesign.
- [ ] Admin vitest suite green; both apps `tsc` + build clean.

## Dependencies / notes

- Blocked-by: none. FE-only except the Fleet Uptime % join uses the existing `/reports/fleet-uptime`
  endpoint (no backend change). Related: #122 (the current table).
- Out of scope: any change to the device drill-down sub-table (`OpenDeviceTickets`) beyond how it is
  triggered; per-plant uptime backfill (that's an OH recompute, not this issue).
