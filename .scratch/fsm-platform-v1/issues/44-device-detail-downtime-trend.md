# 44 — Device Detail + Lifetime Downtime Trend

Status: done
Type: AFK

## What to build

The Device Detail page (`/devices/:deviceId`, ZM / Operations Head). Lifetime downtime history — each Failure Cycle with downtime start/end, total duration, SLA bucket reached, assigned SE, Plant, Company, root cause, component used, vehicle-unavailable impact, component-blocked impact, verification outcome, closure type, auto-recovery flag, repeat-failure flag. Recent detail comes from hot operational records; the lifetime trend comes from monthly summary tables (never multi-year raw scans). Lifetime Downtime Trend views: downtime cycles over lifetime, downtime hours by month, repeat-failure trend, average time to recover, longest downtime episode, auto-recovery vs SE-repaired split, component-related downtime trend, root-cause trend — served from `device_downtime_summary_monthly` via the `DeviceDowntimeSummary` worker.

## Acceptance criteria

- [x] Device Detail lists each Failure Cycle with all documented per-cycle fields
- [x] Recent detail served from hot records; lifetime trend from monthly summaries
- [x] All listed Lifetime Downtime Trend views render
- [x] No multi-year raw telemetry / `ticket_events` scans per request
- [x] Accessible to ZM (own zone) and Operations Head (all zones) *(also CSM)*

## Blocked by

- #08

## Disposition

**Done — backend slice (2026-06-27).** Vertical: extend summary → migration → worker → detail read →
trend read → HTTP, 15 new e2e (3 + 4 + 3 + 5), full suite green, `tsc` clean.

- **Migration** `20260627120000_extend_downtime_summary_cycle_metrics` (additive; 40 total) — adds
  `cycle_count`, `repeat_failure_count`, `longest_episode_seconds`, `recover_seconds_sum`,
  `recovered_cycles`, `component_downtime_seconds` to `device_downtime_summary_monthly`.
- **`FleetUptimeAggregationService` extended** — also writes the per-(device, month) cycle-level aggregates,
  attributed to the month the cycle **opened** in (an open cycle's episode runs to the window end);
  component-related downtime = duration of cycles that incurred a Component Request. `downtimeSeconds` keeps
  its time-weighted-overlap meaning. #39 reads/tests untouched.
- **`DeviceDetailService.deviceCycles`** (`src/devices/device-detail.service.ts`) — the Device Detail
  per-cycle list straight off hot records (bounded to one device): opened/closed + duration, **SLA bucket
  reached** (`classifySlaBucket(duration)`), repeat-failure, assigned SE, plant, company, root cause,
  component-related / **vehicle-unavailable** / **component-blocked** impact, **verification outcome**,
  closure type, **auto-recovery** flag. ZM own-zone (out-of-zone → NOT_FOUND, no existence leak); CSM/OH all.
- **`DeviceDetailService.downtimeTrend`** — lifetime totals + monthly series from
  `device_downtime_summary_monthly` (downtime hours/month, cycles, repeat-failure, auto-vs-SE split,
  component-related downtime, average time-to-recover, longest episode) + a per-device root-cause trend
  (bounded read of that device's submissions). No multi-year/fleet scan.
- **`/api/devices/:id/cycles`** + **`/api/devices/:id/downtime-trend`** (ZM/CSM/OH; SE → 403; unknown → 404;
  non-numeric id → 400). Built onto the existing `/api/devices` controller (Issue 49).

**#49 deal_type tag-control:** the Operations-Head audited `deal_type` tag endpoint
(`PATCH /api/devices/:id/deal-type`) + device read already shipped in #49; this Device Detail surface is
its admin-side consumer. No further backend work for that leg.

**Unblocks FE-22** (Device Detail admin page — FE-series surface consuming these endpoints).
