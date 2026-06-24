# 41 — Root Cause Analytics

Status: ready-for-agent
Type: AFK

## What to build

The Root Cause Analytics view (`/reports/root-cause`). Percentage distribution of device-inactivity root causes (POWER_ISSUE, SIM_NETWORK_ISSUE, GPS_ANTENNA_ISSUE, WIRING_ISSUE, DEVICE_HARDWARE_FAULT, CONFIGURATION_ISSUE, VEHICLE_ACCESS_ISSUE, INSTALLATION_ISSUE, CUSTOMER_SIDE_ISSUE, UNKNOWN) built from the **structured** `root_cause_category` data on the Troubleshooting Form — never parsed from free-text diagnosis notes. Filterable by Fleet / Zone / Company / Plant / device type / SE / time period. Served from `root_cause_summary_monthly` via the `RootCauseSummary` worker (summary tables, not raw scans).

## Acceptance criteria

- [ ] Root-cause % distribution computed from structured `root_cause_category` data only
- [ ] Filterable by Fleet / Zone / Company / Plant / device type / SE / time period
- [ ] Served from `root_cause_summary_monthly` (no free-text parsing, no raw scans)
- [ ] All documented root-cause categories represented

## Blocked by

- #16
