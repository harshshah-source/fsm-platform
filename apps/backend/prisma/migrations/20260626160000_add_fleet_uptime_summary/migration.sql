-- Issue 39 — Fleet Uptime % monthly report. The `FleetUptimeAggregationService` pre-computes one row
-- per (device, month) so the report never scans raw telemetry / multi-year partitions. Downtime is the
-- device's failure-cycle overlap with the month window; `eligible` snapshots the uptime-eligibility gate
-- (active PGI ≤15d AND not Non-Operational) so the denominator is Eligible Devices only. Auto-recovery
-- and SE-repaired closures are counted separately so SE productivity is not inflated (CONTEXT §Reports).
-- zone/company/plant are denormalised for the per-zone / per-company / per-plant breakdown.

CREATE TABLE "device_downtime_summary_monthly" (
  "device_id"              BIGINT       NOT NULL,
  "month"                  DATE         NOT NULL,
  "zone_id"                BIGINT,
  "company_id"             BIGINT,
  "plant_id"               BIGINT,
  "eligible"               BOOLEAN      NOT NULL DEFAULT false,
  "window_seconds"         BIGINT       NOT NULL,
  "downtime_seconds"       BIGINT       NOT NULL DEFAULT 0,
  "auto_recovery_closures" INTEGER      NOT NULL DEFAULT 0,
  "se_repaired_closures"   INTEGER      NOT NULL DEFAULT 0,
  "computed_at"            TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "device_downtime_summary_monthly_pkey" PRIMARY KEY ("device_id", "month")
);

-- Report read paths: per-month zone/company/plant rollup, eligible-only denominator.
CREATE INDEX "ddsm_month_zone_idx" ON "device_downtime_summary_monthly" ("month", "zone_id");
CREATE INDEX "ddsm_month_eligible_idx" ON "device_downtime_summary_monthly" ("month", "eligible");
