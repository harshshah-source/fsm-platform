-- Issue 42 — System Efficiency Report daily cube. Additive counts + stage-time second-sums per
-- (day, zone, company, plant, device_type, SE). Rebuilt per day (delete + insert); surrogate id PK
-- because the dimension columns are nullable.

CREATE TABLE "system_efficiency_summary_daily" (
  "id"                          BIGSERIAL      NOT NULL,
  "day"                         DATE           NOT NULL,
  "zone_id"                     BIGINT,
  "company_id"                  BIGINT,
  "plant_id"                    BIGINT,
  "device_type"                 TEXT,
  "se_id"                       UUID,

  "failure_cycles_opened"        INTEGER       NOT NULL DEFAULT 0,
  "tickets_created"              INTEGER       NOT NULL DEFAULT 0,
  "troubleshoot_tickets_created" INTEGER       NOT NULL DEFAULT 0,
  "auto_assignments"             INTEGER       NOT NULL DEFAULT 0,
  "manual_assignments"           INTEGER       NOT NULL DEFAULT 0,
  "overrides"                    INTEGER       NOT NULL DEFAULT 0,
  "cycles_resolved"              INTEGER       NOT NULL DEFAULT 0,
  "verified_cycles"              INTEGER       NOT NULL DEFAULT 0,
  "failed_verifications"         INTEGER       NOT NULL DEFAULT 0,
  "auto_recoveries"              INTEGER       NOT NULL DEFAULT 0,
  "repeat_failures"              INTEGER       NOT NULL DEFAULT 0,
  "first_time_fixes"             INTEGER       NOT NULL DEFAULT 0,
  "component_pauses"             INTEGER       NOT NULL DEFAULT 0,
  "aged_resolutions"             INTEGER       NOT NULL DEFAULT 0,
  "sla_compliant_resolutions"    INTEGER       NOT NULL DEFAULT 0,
  "auto_escalations"             INTEGER       NOT NULL DEFAULT 0,

  "downtime_seconds_sum"                  BIGINT  NOT NULL DEFAULT 0,
  "detection_to_ticket_seconds_sum"       BIGINT  NOT NULL DEFAULT 0,
  "detection_to_ticket_count"             INTEGER NOT NULL DEFAULT 0,
  "ticket_to_assignment_seconds_sum"      BIGINT  NOT NULL DEFAULT 0,
  "ticket_to_assignment_count"            INTEGER NOT NULL DEFAULT 0,
  "assignment_to_onsite_seconds_sum"      BIGINT  NOT NULL DEFAULT 0,
  "assignment_to_onsite_count"            INTEGER NOT NULL DEFAULT 0,
  "onsite_to_submission_seconds_sum"      BIGINT  NOT NULL DEFAULT 0,
  "onsite_to_submission_count"            INTEGER NOT NULL DEFAULT 0,
  "submission_to_verification_seconds_sum" BIGINT NOT NULL DEFAULT 0,
  "submission_to_verification_count"      INTEGER NOT NULL DEFAULT 0,
  "warehouse_fulfilment_seconds_sum"      BIGINT  NOT NULL DEFAULT 0,
  "warehouse_fulfilment_count"            INTEGER NOT NULL DEFAULT 0,
  "recovery_closure_seconds_sum"          BIGINT  NOT NULL DEFAULT 0,
  "recovery_closure_count"                INTEGER NOT NULL DEFAULT 0,

  "computed_at"                 TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "system_efficiency_summary_daily_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sesd_day_idx" ON "system_efficiency_summary_daily" ("day");
CREATE INDEX "sesd_day_zone_idx" ON "system_efficiency_summary_daily" ("day", "zone_id");
