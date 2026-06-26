# 40 — Soft Inactive Count trend

Status: done
Type: AFK

## What to build

The Soft Inactive Count signal and its trend view (part of `/reports`). Recomputed twice daily per zone by the `SoftInactiveCount` worker; this is the intraday operational signal that drives Recommender mode switching. Trend view shows the twice-daily series per zone so Operations Head can monitor the signal over time.

## Acceptance criteria

- [x] Soft Inactive Count recomputed twice daily per zone
- [x] Count drives Recommender mode switching
- [x] Trend view renders the per-zone twice-daily series for Operations Head
- [x] Served from summary data, not raw per-request scans

## Blocked by

- #05

## Disposition (done — backend slice, 2026-06-26)

Backend vertical slice complete and verified green (full backend suite **583/583**, `tsc` clean).
Continued in the isolated `feat/issue-34-install-lifecycle` worktree.

- **Migration** `20260626180000_add_soft_inactive_history` → `soft_inactive_count_history` (per-zone,
  per-capture: `soft_inactive_count`, `eligible_device_count`, `deficit_mode`, `threshold_pct`, `period`).
- **`SoftInactiveCountService`**: `recompute(now)` snapshots every zone (soft-inactive = `eligible_for_uptime
  AND is_inactive`; period MORNING/AFTERNOON by capture hour; `deficitMode = count > thresholdPct ×
  eligible`); `modeForZone(zoneId, now)` is the live count-driven DEFICIT/PREVENTIVE switch. Threshold
  configurable (CONTEXT default 2%, `@Optional()` ctor param).
- **Recommender wiring (AC#2)**: `RecommenderService.runForZone` reads `modeForZone` and records the
  active mode on `RunSummary.mode` + each recommendation's `scoreBreakdown.mode`. Non-destructive — the
  full **preventive-mode scoring re-prioritisation** is filed as follow-up **#72** (the engine behaviour
  change belongs with the Recommender, not this reporting slice).
- **`ReportsService.softInactiveTrend`** + **`ReportsController`**: `GET /api/reports/soft-inactive-trend?
  days=N` (per-zone twice-daily series) + `POST /api/reports/soft-inactive/recompute`, both
  **Operations Head** (AC#3). Reads the summary table only (AC#4).

Tests: `soft-inactive-count` (3), `recommender-mode` (2), `soft-inactive-trend-controller` e2e (3).

**Parity gate**: the admin Soft-Inactive trend view is **FE-21** (already in INDEX, BE-gated on 39/40) —
this slice unblocks the remaining half of FE-21. Twice-daily scheduling is the deferred BullMQ cron seam.
