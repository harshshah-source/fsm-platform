-- Issue 41 — Root Cause Analytics. The `RootCauseAnalyticsAggregationService` rebuilds, per month, one
-- row per (month, zone, company, plant, device_type, SE, root_cause_category) holding the count of
-- structured-root-cause troubleshooting submissions in that bucket (CONTEXT §Root Cause Analytics:
-- the analytics source is the structured `root_cause_category` field — never parsed from free-text
-- diagnosis notes). The report reads this pre-aggregated cube and zero-fills the full category set;
-- it never scans raw `troubleshooting_submissions`. Rebuilt per month (delete + insert) → idempotent.

CREATE TABLE "root_cause_summary_monthly" (
  "id"                  BIGSERIAL              NOT NULL,
  "month"               DATE                   NOT NULL,
  "zone_id"             BIGINT,
  "company_id"          BIGINT,
  "plant_id"            BIGINT,
  "device_type"         TEXT,
  "se_id"               UUID                   NOT NULL,
  "root_cause_category" "root_cause_category"  NOT NULL,
  "submission_count"    INTEGER                NOT NULL DEFAULT 0,
  "computed_at"         TIMESTAMPTZ(6)         NOT NULL,
  CONSTRAINT "root_cause_summary_monthly_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "rcsm_month_idx" ON "root_cause_summary_monthly" ("month");
CREATE INDEX "rcsm_month_zone_idx" ON "root_cause_summary_monthly" ("month", "zone_id");
