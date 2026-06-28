-- Issue 29/30 — system-triggered intra-day CRITICAL insertion + SE Accept/Decline + timeout reroute.
-- The mutable offer state machine (the append-only `recommendations` table stays untouched).

CREATE TYPE "intraday_insertion_status" AS ENUM (
  'PENDING_ACCEPTANCE',
  'ACCEPTED',
  'DECLINED',
  'TIMED_OUT',
  'ESCALATION_REQUIRED'
);

CREATE TABLE "intraday_insertions" (
  "insertion_id"        BIGSERIAL                  NOT NULL,
  "ticket_id"           UUID                       NOT NULL,
  "zone_id"             BIGINT                     NOT NULL,
  "insertion_type"      TEXT                       NOT NULL DEFAULT 'SYSTEM_CRITICAL',
  "sla_bucket"          "sla_bucket",
  "offered_se_id"       UUID                       NOT NULL,
  "offered_at"          TIMESTAMPTZ(6)             NOT NULL,
  "acceptance_deadline" TIMESTAMPTZ(6)             NOT NULL,
  "status"              "intraday_insertion_status" NOT NULL DEFAULT 'PENDING_ACCEPTANCE',
  "responded_at"        TIMESTAMPTZ(6),
  "decline_reason_code" TEXT,
  "retry_count"         INTEGER                    NOT NULL DEFAULT 0,
  "retry_chain"         JSONB                      NOT NULL DEFAULT '[]',
  "whatsapp_sent_at"    TIMESTAMPTZ(6),
  "assigned_schedule_id" BIGINT,
  "assigned_batch_id"   BIGINT,
  "created_at"          TIMESTAMPTZ(6)             NOT NULL DEFAULT now(),
  "updated_at"          TIMESTAMPTZ(6)             NOT NULL,

  CONSTRAINT "intraday_insertions_pkey" PRIMARY KEY ("insertion_id")
);

CREATE INDEX "intraday_insertions_zone_id_status_idx" ON "intraday_insertions" ("zone_id", "status");
CREATE INDEX "intraday_insertions_ticket_id_idx" ON "intraday_insertions" ("ticket_id");
CREATE INDEX "intraday_insertions_status_acceptance_deadline_idx" ON "intraday_insertions" ("status", "acceptance_deadline");

ALTER TABLE "intraday_insertions"
  ADD CONSTRAINT "intraday_insertions_ticket_id_fkey"
  FOREIGN KEY ("ticket_id") REFERENCES "tickets" ("ticket_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "intraday_insertions"
  ADD CONSTRAINT "intraday_insertions_zone_id_fkey"
  FOREIGN KEY ("zone_id") REFERENCES "zones" ("zone_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "intraday_insertions"
  ADD CONSTRAINT "intraday_insertions_offered_se_id_fkey"
  FOREIGN KEY ("offered_se_id") REFERENCES "engineer_master" ("engineer_id") ON DELETE RESTRICT ON UPDATE CASCADE;
