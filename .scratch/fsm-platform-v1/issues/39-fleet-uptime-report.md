# 39 — Fleet Uptime % monthly report

Status: done
Type: AFK

## What to build

The Fleet Uptime % report (part of `/reports`). Monthly, time-weighted, eligibility-gated: the denominator is **Eligible Devices only** (active PGI within ~15 days AND not Non-Operational) — never raw installed-device count — shown per zone / company / plant. Served from the `device_downtime_summary_monthly` / monthly summary tables (never raw telemetry or multi-year scans), produced by the `FleetUptimeMonthly` / summary aggregation worker. Reports must clearly separate `CLOSED_AUTO_RECOVERY` from SE-repaired closures so SE productivity is not inflated.

## Acceptance criteria

- [x] Fleet Uptime % computed monthly, time-weighted, over the Eligible Devices denominator
- [x] Breakdown available per zone / company / plant
- [x] Denominator excludes Non-Operational and non-recent-PGI devices
- [x] Report reads from monthly summary tables, not raw telemetry / multi-year scans
- [x] Auto-recovery closures separated from SE-repaired closures

## Blocked by

- #05
- #08

## Disposition (done — backend slice, 2026-06-26)

Backend vertical slice complete and verified green (full backend suite **575/575**, `tsc` clean). Built
in the isolated `feat/issue-34-install-lifecycle` worktree (continued backend line; no FE-worktree touch).

- **Migration** `20260626160000_add_fleet_uptime_summary`: new `device_downtime_summary_monthly`
  (PK `(device_id, month)`; `window_seconds`, `downtime_seconds`, `eligible`, `auto_recovery_closures`,
  `se_repaired_closures`, denormalised `zone/company/plant`; `(month,zone)` + `(month,eligible)` indexes).
- **`FleetUptimeAggregationService.computeMonth(month, now)`**: pre-computes one row per device.
  Downtime = the device's **failure-cycle overlap** with the month window (clamped to month boundaries;
  open cycles run to `window_end = min(now, month_end)` so an incomplete current month isn't penalised).
  `eligible` snapshots `device_states.eligible_for_uptime` (the existing gate: active PGI ≤15d AND not
  Non-Op). Auto-recovery (`CLOSED_AUTO_RECOVERY`) vs SE-repaired (`CLOSED`) closures counted per device.
  Idempotent per-device upsert. On-demand (no scheduler) — same posture as `VerificationService`.
- **`ReportsService.fleetUptime(scope, {month, groupBy})`**: reads **only** the summary table; uptime% =
  time-weighted `(1 − Σdowntime/Σwindow) × 100` over `eligible = true` rows; per zone/company/plant; a
  ZM is scoped to own zone; returns per-group rows + a fleet total.
- **`ReportsModule` + `ReportsController`**: `GET /api/reports/fleet-uptime?month&groupBy` (manager roles,
  ZM zone-scoped) + `POST /api/reports/fleet-uptime/recompute` (Operations Head). Registered in AppModule.

Tests: `fleet-uptime-aggregation` (6), `fleet-uptime-report` (4), `reports-controller` e2e (5).

**Deviations**: (1) `eligible` uses the **current** `device_states.eligible_for_uptime` (the worker is
intended to run at/just-after month-end, so current ≈ month-end eligibility); true intra-month
point-in-time eligibility is deferred. (2) The recompute is an Operations-Head endpoint until a month-end
**BullMQ cron** lands (external/infra seam, same deferral posture as the rest of P1–P7).

**Parity gate**: the admin Reports landing + Fleet Uptime chart is **FE-21** (already in INDEX,
BE-gated on 39/40) — this slice unblocks it; no new follow-up needed.
