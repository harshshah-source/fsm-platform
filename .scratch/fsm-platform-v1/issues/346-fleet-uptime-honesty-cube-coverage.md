# 346 — Fleet-uptime honesty + monthly cube coverage
Status: ready-for-agent
Type: AFK
Wave: 2 · Severity: P1 · Found by: module-gaps survey 2026-09-02, verified against the working tree 2026-09-03 (`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4)

## Problem

`reports.service.ts:703-706` returns `100` for a zero window. The controller defaults to the
current month (`reports.controller.ts:117-120`) while the crons only ever write the **previous**
month (`business-sweep-scheduler.service.ts:124-126, 255-273`), so the default view is a month with
no cube row. The admin 6-month trend (`api/reports.ts:63-69`) plots `uptimePct` with no
`eligibleDeviceCount` guard, so the trend reads 100, 100, 100, 56.19, 100, 100. Zone/plant maps
(`:86,:92`) and the Reports KPI (`ReportsPage.tsx:113`) are unguarded; only the dashboard hero is
guarded (`ManagerDashboard.tsx:85`). No test covers an empty month.

## Current code

- `reports.service.ts:703-706` — `uptimePct` = 100 when the window is zero
- `reports.controller.ts:117-120` — defaults to the current month
- `business-sweep-scheduler.service.ts:124-126, 255-273` — fleet-uptime / root-cause /
  zm-performance ticks compute only the previous month
- `fleet-uptime-aggregation.service.ts:51` — already clamps `windowEnd = min(now, monthEnd)`
- Admin `api/reports.ts:20-47,63-69` — types and 6-month trend, no `eligibleDeviceCount` guard
- Admin `api/reports.ts:86,92` — zone/plant maps unguarded
- Admin `ReportsPage.tsx:113` — KPI unguarded; `:265-276` trend
- Admin `ManagerDashboard.tsx:85` — the one guarded consumer (reference shape)

## What to build

- `reports.service.ts` — `uptimePct` → `null` when window ≤ 0; type
  `FleetUptimeReport.fleet.uptimePct: number | null`, same for zone/plant rows
- Admin `api/reports.ts:20-47,63-69` — nullable types; trend carries the gap
- Admin `ReportsPage.tsx:113,265-276` — "no data" state for the KPI; trend shows a gap, not zero
- Admin `ZmScorecardPage` and the company-plant columns that read the zone/plant maps — same guard
- `business-sweep-scheduler.service.ts` — fleet-uptime, root-cause and zm-performance ticks compute
  **previous and current** month daily (the aggregation already clamps `windowEnd` at
  `fleet-uptime-aggregation.service.ts:51`)
- Tests: `fleet-uptime-report.e2e-spec.ts`, `reports-controller.e2e-spec.ts`,
  `scheduler-wiring.e2e-spec.ts`, admin trend test

## Acceptance criteria

- [ ] AC1 — empty window → `uptimePct: null`, `eligibleDeviceCount: 0`, never 100
- [ ] AC2 — trend chart shows a gap / "no data" for such months
- [ ] AC3 — current month is recomputed daily and the previous month is still finalised on the
      first of the month
- [ ] AC4 — e2e for the empty month
- [ ] AC5 — manual recompute endpoints unchanged

## Verification

e2e for AC1, AC3, AC4; admin test for AC2.

## UI surfaces

- Admin: Reports page — Fleet Uptime KPI and 6-month trend (modified: "no data" state, trend gap)
- Admin: ZM Scorecard page and company-plant columns (modified: null guard)

## Reference

n/a (no layout change — existing surfaces gain a "no data" state)

## Blocked by

— (none; may start in wave 1 if capacity exists — plan §5)

## Absorbs / supersedes

- survey ids: RPT-01, RPT-02, RPT-09
- existing issues: none named

## Downstream

365 (SE productivity report) depends on this (plan §3).
