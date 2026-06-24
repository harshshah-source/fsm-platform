# 44 — Device Detail + Lifetime Downtime Trend

Status: ready-for-agent
Type: AFK

## What to build

The Device Detail page (`/devices/:deviceId`, ZM / Operations Head). Lifetime downtime history — each Failure Cycle with downtime start/end, total duration, SLA bucket reached, assigned SE, Plant, Company, root cause, component used, vehicle-unavailable impact, component-blocked impact, verification outcome, closure type, auto-recovery flag, repeat-failure flag. Recent detail comes from hot operational records; the lifetime trend comes from monthly summary tables (never multi-year raw scans). Lifetime Downtime Trend views: downtime cycles over lifetime, downtime hours by month, repeat-failure trend, average time to recover, longest downtime episode, auto-recovery vs SE-repaired split, component-related downtime trend, root-cause trend — served from `device_downtime_summary_monthly` via the `DeviceDowntimeSummary` worker.

## Acceptance criteria

- [ ] Device Detail lists each Failure Cycle with all documented per-cycle fields
- [ ] Recent detail served from hot records; lifetime trend from monthly summaries
- [ ] All listed Lifetime Downtime Trend views render
- [ ] No multi-year raw telemetry / `ticket_events` scans per request
- [ ] Accessible to ZM (own zone) and Operations Head (all zones)

## Blocked by

- #08
