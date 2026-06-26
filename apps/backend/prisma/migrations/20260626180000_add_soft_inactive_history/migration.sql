-- Issue 40 — Soft Inactive Count trend. The `SoftInactiveCountService` snapshots, twice daily per zone,
-- the count of Eligible Devices currently silent >24h (CONTEXT §5: same eligibility filter as Fleet
-- Uptime). Each row records the soft-inactive count, the eligible denominator, the deficit-mode flag
-- (soft_inactive > threshold_pct × eligible — drives the Recommender's deficit/preventive switch), and
-- the threshold used. The trend report reads this summary, never raw per-request device scans.

CREATE TABLE "soft_inactive_count_history" (
  "id"                    BIGSERIAL    NOT NULL,
  "zone_id"               BIGINT       NOT NULL,
  "captured_at"           TIMESTAMPTZ(6) NOT NULL,
  "period"                TEXT         NOT NULL,
  "soft_inactive_count"   INTEGER      NOT NULL,
  "eligible_device_count" INTEGER      NOT NULL,
  "deficit_mode"          BOOLEAN      NOT NULL,
  "threshold_pct"         DECIMAL(6,4) NOT NULL,
  CONSTRAINT "soft_inactive_count_history_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sich_zone_captured_idx" ON "soft_inactive_count_history" ("zone_id", "captured_at" DESC);
CREATE INDEX "sich_captured_idx" ON "soft_inactive_count_history" ("captured_at" DESC);
