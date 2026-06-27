-- Issue 44 — Lifetime Downtime Trend. Extend `device_downtime_summary_monthly` (Issue 39) with the
-- per-(device, month) cycle-level aggregates the Device Detail trend needs, so the lifetime trend reads
-- the summary instead of scanning raw failure cycles per request. Cycle-level metrics are attributed to
-- the month the cycle OPENED in (avoids double-counting a multi-month cycle); `downtime_seconds` keeps
-- its time-weighted overlap meaning. `component_downtime_seconds` is the duration of cycles that incurred
-- a Component Request (WAITING_COMPONENT impact). All additive, defaulted — the Fleet Uptime read is
-- untouched.

ALTER TABLE "device_downtime_summary_monthly"
  ADD COLUMN "cycle_count"                INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "repeat_failure_count"       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "longest_episode_seconds"    BIGINT  NOT NULL DEFAULT 0,
  ADD COLUMN "recover_seconds_sum"        BIGINT  NOT NULL DEFAULT 0,
  ADD COLUMN "recovered_cycles"           INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "component_downtime_seconds" BIGINT  NOT NULL DEFAULT 0;
