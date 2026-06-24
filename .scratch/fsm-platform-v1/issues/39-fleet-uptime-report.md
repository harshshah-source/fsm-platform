# 39 — Fleet Uptime % monthly report

Status: ready-for-agent
Type: AFK

## What to build

The Fleet Uptime % report (part of `/reports`). Monthly, time-weighted, eligibility-gated: the denominator is **Eligible Devices only** (active PGI within ~15 days AND not Non-Operational) — never raw installed-device count — shown per zone / company / plant. Served from the `device_downtime_summary_monthly` / monthly summary tables (never raw telemetry or multi-year scans), produced by the `FleetUptimeMonthly` / summary aggregation worker. Reports must clearly separate `CLOSED_AUTO_RECOVERY` from SE-repaired closures so SE productivity is not inflated.

## Acceptance criteria

- [ ] Fleet Uptime % computed monthly, time-weighted, over the Eligible Devices denominator
- [ ] Breakdown available per zone / company / plant
- [ ] Denominator excludes Non-Operational and non-recent-PGI devices
- [ ] Report reads from monthly summary tables, not raw telemetry / multi-year scans
- [ ] Auto-recovery closures separated from SE-repaired closures

## Blocked by

- #05
- #08
