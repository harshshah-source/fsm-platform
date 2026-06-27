# 41 — Root Cause Analytics

Status: done
Type: AFK

## What to build

The Root Cause Analytics view (`/reports/root-cause`). Percentage distribution of device-inactivity root causes (POWER_ISSUE, SIM_NETWORK_ISSUE, GPS_ANTENNA_ISSUE, WIRING_ISSUE, DEVICE_HARDWARE_FAULT, CONFIGURATION_ISSUE, VEHICLE_ACCESS_ISSUE, INSTALLATION_ISSUE, CUSTOMER_SIDE_ISSUE, UNKNOWN) built from the **structured** `root_cause_category` data on the Troubleshooting Form — never parsed from free-text diagnosis notes. Filterable by Fleet / Zone / Company / Plant / device type / SE / time period. Served from `root_cause_summary_monthly` via the `RootCauseSummary` worker (summary tables, not raw scans).

## Acceptance criteria

- [x] Root-cause % distribution computed from structured `root_cause_category` data only
- [x] Filterable by Fleet / Zone / Company / Plant / device type / SE / time period
- [x] Served from `root_cause_summary_monthly` (no free-text parsing, no raw scans)
- [x] All documented root-cause categories represented

## Blocked by

- #16

## Disposition

**Done — backend slice (2026-06-27).** Vertical: schema → migration → aggregation worker → read →
HTTP, 13 new e2e (4 + 4 + 5), full suite **172 files / 596 passed / 0 failed**, `tsc` clean.

- **Migration** `20260626190000_add_root_cause_summary` (additive; 38 total, 0 pending) +
  `RootCauseSummaryMonthly` model: the pre-aggregated cube
  `(month, zone, company, plant, device_type, SE, root_cause_category) → submission_count`.
- **`RootCauseAnalyticsAggregationService.computeMonth`** (`src/reports/root-cause-aggregation.service.ts`)
  rebuilds a month by delete + grouped insert in one transaction (idempotent). The count is sourced from
  the **structured** `root_cause_category` only — diagnosis free-text is never parsed. Submission month =
  `submitted_at`; zone via ticket-plant → zone; company/plant from the ticket; device_type from the device.
  On-demand (no scheduler), same posture as the Fleet Uptime worker.
- **`ReportsService.rootCause`** reads the cube only (AC#3): % distribution, **all 10 documented
  categories zero-filled** in canonical order (AC#4), `pct = count/total ×100` (2 dp). Filterable by
  Zone / Company / Plant / device type / SE / month range (AC#2); **Fleet** = no filter. A ZONAL_MANAGER
  is pinned to their own zone; CSM / Operations Head see all and may filter by one.
- **`/api/reports/root-cause`** (`GET`, manager roles, ZM zone-scoped) + **`/api/reports/root-cause/recompute`**
  (`POST`, Operations Head). SE → 403; ZM recompute → 403; invalid month → 400.

**Unblocks FE-23** (Root Cause Analytics admin chart page — FE-series surface, consumes this endpoint;
mirrors how #39/#40 fed FE-21).

**Deferred (external-integration seam, not silent):** the month-end BullMQ cron that auto-runs
`computeMonth` — same deferral as #39/#40; the recompute endpoint is the manual trigger until scheduling
lands.
