-- Issue 43 — ZM Performance Scorecard. The `ZmPerformanceAggregationService` rebuilds, per month, one
-- row per (month, zone, ZM user) holding that ZM's audited decision-activity counts (overrides + by
-- type, override-after-ON_SITE, manual assignments) plus the zone's auto-assignment denominator (for
-- override rate) and the zone's Fleet-Uptime inputs (for zone SLA compliance). Sourced from `audit_logs`
-- (native ZM actions: actor_role = ZONAL_MANAGER), `plant_batch_assignments`, and
-- `device_downtime_summary_monthly` — never raw multi-year scans. Operations-Head only; never the ZM.
-- Rebuilt per month (delete + insert) → idempotent.

CREATE TABLE "zm_performance_summary_monthly" (
  "id"                    BIGSERIAL      NOT NULL,
  "month"                 DATE           NOT NULL,
  "zone_id"               BIGINT         NOT NULL,
  "zm_id"                 UUID           NOT NULL,
  "overrides_total"       INTEGER        NOT NULL DEFAULT 0,
  "removals"              INTEGER        NOT NULL DEFAULT 0,
  "deferrals"             INTEGER        NOT NULL DEFAULT 0,
  "reorders"              INTEGER        NOT NULL DEFAULT 0,
  "swaps"                 INTEGER        NOT NULL DEFAULT 0,
  "reassignments"         INTEGER        NOT NULL DEFAULT 0,
  "split_batches"         INTEGER        NOT NULL DEFAULT 0,
  "override_after_onsite" INTEGER        NOT NULL DEFAULT 0,
  "manual_assignments"    INTEGER        NOT NULL DEFAULT 0,
  "auto_assigned_count"   INTEGER        NOT NULL DEFAULT 0,
  "zone_eligible_devices" INTEGER        NOT NULL DEFAULT 0,
  "zone_downtime_seconds" BIGINT         NOT NULL DEFAULT 0,
  "zone_window_seconds"   BIGINT         NOT NULL DEFAULT 0,
  "computed_at"           TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "zm_performance_summary_monthly_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "zpsm_month_idx" ON "zm_performance_summary_monthly" ("month");
CREATE INDEX "zpsm_month_zone_idx" ON "zm_performance_summary_monthly" ("month", "zone_id");
CREATE INDEX "zpsm_month_zm_idx" ON "zm_performance_summary_monthly" ("month", "zm_id");
