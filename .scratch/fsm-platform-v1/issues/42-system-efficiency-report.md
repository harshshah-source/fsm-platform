# 42 — System Efficiency Report

Status: done
Type: AFK

## What to build

The System Efficiency Report (`/reports/efficiency`) measuring end-to-end operational performance: devices detected, Failure Cycles, tickets auto-created, auto-assignment success rate, manual assignment rate, ZM override rate, stage times (detection-to-ticket, ticket-to-assignment, assignment-to-ON_SITE, ON_SITE-to-submission, submission-to-verification), total/average downtime, SLA compliance %, pause and aging counts, repeat-failure rate, first-time-fix rate, failed-verification rate, auto-recovery rate, warehouse fulfilment time, recovery closure time, and auto-escalations triggered per zone. Filterable by Fleet / Zone / Company / Plant / device type / SE / time period; served from `system_efficiency_summary_daily` (summary tables for long ranges) via the `SystemEfficiencySummary` worker.

## Acceptance criteria

- [x] All listed efficiency metrics computed and rendered
- [x] Filterable by Fleet / Zone / Company / Plant / device type / SE / time period
- [x] Served from `system_efficiency_summary_daily` for long ranges (no raw multi-year scans)
- [x] Auto-assignment vs manual-assignment and override rates shown
- [x] Auto-escalations per zone included

## Blocked by

- #08
- #18
- #30

## Disposition (done — 2026-06-28, backend worktree)

Backend slice, mirroring the reports cluster (Issues 39/41/43). New **`system_efficiency_summary_daily`**
cube (migration `20260628160000`): one **partial** row per (day, zone, company, plant, device_type, SE)
holding a metric family's **additive** daily counts + stage-time second-sums (surrogate `id` PK — the dims
are nullable). The read SUMs every partial row in the date range and derives the rates / average stage
times from the additive numerators & denominators, so long ranges never scan raw telemetry.

- **`SystemEfficiencyAggregationService.computeDay(day)`** (`src/reports/`) — delete + 11
  `INSERT … SELECT … GROUP BY` statements in one transaction, each populating one family from its source:
  failure cycles (detection, repeat) · tickets created + detection→ticket · cycle resolution (downtime,
  first-time-fix, aging, SLA-compliance, component pause) · verification outcomes (failed-verification,
  auto-recovery, submission→verification) · auto-assignments (Morning-Batch Recommendations, SE-attributed)
  · manual-assignments (`CRITICAL_ASSIGN`/`MANUAL_ZM_UPDATE`/`CROSS_ZONE_ASSIGN` audit) · overrides
  (`BATCH_OVERRIDE_*` audit, SE-attributed) · ticket→assignment + assignment→ON_SITE + ON_SITE→submission
  (per-ticket event MINs) · warehouse fulfilment (Component Requests) · recovery closure (RECOVERY ticket
  events) · auto-escalations per zone (cross-zone `AUTO_PLATINUM` + intra-day `ESCALATION_REQUIRED`).
  Idempotent (delete-by-day); on-demand worker (daily BullMQ cron deferred, same posture as the cluster).
- **`ReportsService.systemEfficiency(scope, filters)`** — sums the cube over a day range with the
  Fleet/Zone/Company/Plant/device-type/SE filters (ZM restricted to own zone), returns a **fleet rollup +
  per-zone breakdown** (so auto-escalations-per-zone surfaces) with all rates + avg stage times derived.
- **HTTP**: `GET /api/reports/efficiency` (managers, zone-scoped) + `POST …/efficiency/recompute` (OH),
  added to the existing `ReportsController`/`ReportsModule`.

4 aggregation/read e2e + 5 controller e2e green; `tsc` clean.

**Documented metric definitions / simplifications** (in code): `devicesDetected` = failure cycles opened;
`firstTimeFix` = VERIFIED with no pause + not repeat; `slaCompliance` = resolved ≤ 48h; `failedVerification
rate` = failed ÷ (failed + verified); `autoRecovery rate` = auto ÷ (resolved + auto). The `SE` filter
narrows to **SE-attributable** families (auto-assignments, overrides); device/cycle/stage metrics are
fleet/zone/plant-level (`se_id` NULL). `onsite→submission` & `warehouse fulfilment` avgs render null when
no submission/component-request data exists in range (computed-where-data-exists).

**Deferred (UI):** the admin Reports page (FE-24, ref 24) is presentation over this API → already tracked
in INDEX (FE-24, backend-gated on BE-42, now unblocked).
