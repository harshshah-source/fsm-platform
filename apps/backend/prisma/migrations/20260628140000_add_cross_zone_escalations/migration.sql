-- Issue 32 — cross-zone Platinum auto-escalation + ZM manual flag → CSM cross-zone queue.
-- A parallel escalation record; the Ticket stays in its home queue (no status flip).

CREATE TYPE "cross_zone_escalation_type" AS ENUM ('AUTO_PLATINUM', 'MANUAL_FLAG');

CREATE TYPE "cross_zone_escalation_status" AS ENUM (
  'PENDING',
  'APPROVED',
  'DENIED',
  'DEFERRED',
  'ESCALATED_TO_OPS'
);

CREATE TABLE "cross_zone_escalations" (
  "escalation_id"        BIGSERIAL                     NOT NULL,
  "ticket_id"            UUID                          NOT NULL,
  "home_zone_id"         BIGINT                        NOT NULL,
  "company_tier"         "company_tier"                NOT NULL,
  "escalation_type"      "cross_zone_escalation_type"  NOT NULL,
  "status"               "cross_zone_escalation_status" NOT NULL DEFAULT 'PENDING',
  "trigger_bucket"       "sla_bucket",
  "flag_reason"          TEXT,
  "decision_reason"      TEXT,
  "review_date"          TIMESTAMPTZ(6),
  "target_zone_id"       BIGINT,
  "assigned_se_id"       UUID,
  "assigned_schedule_id" BIGINT,
  "assigned_batch_id"    BIGINT,
  "raised_by_user_id"    UUID,
  "raised_by_role"       TEXT,
  "decided_by_user_id"   UUID,
  "decided_by_role"      TEXT,
  "decided_at"           TIMESTAMPTZ(6),
  "created_at"           TIMESTAMPTZ(6)                NOT NULL DEFAULT now(),
  "updated_at"           TIMESTAMPTZ(6)                NOT NULL,

  CONSTRAINT "cross_zone_escalations_pkey" PRIMARY KEY ("escalation_id")
);

CREATE INDEX "cross_zone_escalations_status_escalation_type_idx" ON "cross_zone_escalations" ("status", "escalation_type");
CREATE INDEX "cross_zone_escalations_home_zone_id_idx" ON "cross_zone_escalations" ("home_zone_id");
CREATE INDEX "cross_zone_escalations_ticket_id_idx" ON "cross_zone_escalations" ("ticket_id");

ALTER TABLE "cross_zone_escalations"
  ADD CONSTRAINT "cross_zone_escalations_ticket_id_fkey"
  FOREIGN KEY ("ticket_id") REFERENCES "tickets" ("ticket_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cross_zone_escalations"
  ADD CONSTRAINT "cross_zone_escalations_home_zone_id_fkey"
  FOREIGN KEY ("home_zone_id") REFERENCES "zones" ("zone_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cross_zone_escalations"
  ADD CONSTRAINT "cross_zone_escalations_target_zone_id_fkey"
  FOREIGN KEY ("target_zone_id") REFERENCES "zones" ("zone_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cross_zone_escalations"
  ADD CONSTRAINT "cross_zone_escalations_assigned_se_id_fkey"
  FOREIGN KEY ("assigned_se_id") REFERENCES "engineer_master" ("engineer_id") ON DELETE RESTRICT ON UPDATE CASCADE;
