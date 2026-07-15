-- Batch-Assignment transparency ledger. Three observe-only tables written inside the existing
-- dispatch flow (record, don't alter — selection/scoring/ordering untouched):
--   dispatch_runs            one row per runForActiveZones invocation (snapshot_runs posture);
--                            config_snapshot captured AT RUN START so history shows the config
--                            that applied (weights, capacity map, eligibility_mode, flag/cron).
--   dispatch_run_zones       per-zone totals + mode + unassignable reason buckets
--                            (NO_COVERAGE = Ops coverage gap vs ALL_DROPPED = filters emptied pool).
--   dispatch_decision_traces bounded per-ticket trace, 1:1 with the run's recommendations row:
--                            per-filter drop COUNTS, chosen-SE precedence context, top-5 runners-up.
-- Plus run_id links on recommendations and work_schedules (nullable, no backfill — null for
-- pre-ledger rows, the intraday path, and ZM_MANUAL schedules).
-- Retention (#104 matrix): traces 90d (same window as recommendations); runs/zones 400d.

CREATE TYPE "dispatch_run_trigger" AS ENUM ('CRON', 'MANUAL');
CREATE TYPE "dispatch_run_status" AS ENUM ('RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED');
CREATE TYPE "dispatch_zone_mode" AS ENUM ('DEFICIT', 'PREVENTIVE');

CREATE TABLE "dispatch_runs" (
  "run_id"             BIGSERIAL             NOT NULL,
  "trigger"            "dispatch_run_trigger" NOT NULL,
  "actor_user_id"      UUID,
  "actor_role"         TEXT,
  "started_at"         TIMESTAMPTZ(6)        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at"        TIMESTAMPTZ(6),
  "status"             "dispatch_run_status" NOT NULL DEFAULT 'RUNNING',
  "zones"              INTEGER               NOT NULL DEFAULT 0,
  "schedules"          INTEGER               NOT NULL DEFAULT 0,
  "batches"            INTEGER               NOT NULL DEFAULT 0,
  "tickets_dispatched" INTEGER               NOT NULL DEFAULT 0,
  "recommended"        INTEGER               NOT NULL DEFAULT 0,
  "unassignable"       INTEGER               NOT NULL DEFAULT 0,
  "config_snapshot"    JSONB                 NOT NULL,
  "created_at"         TIMESTAMPTZ(6)        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMPTZ(6)        NOT NULL,
  CONSTRAINT "dispatch_runs_pkey" PRIMARY KEY ("run_id")
);

CREATE INDEX "dispatch_runs_started_at_idx" ON "dispatch_runs"("started_at" DESC);

CREATE TABLE "dispatch_run_zones" (
  "id"                   BIGSERIAL           NOT NULL,
  "run_id"               BIGINT              NOT NULL,
  "zone_id"              BIGINT              NOT NULL,
  "mode"                 "dispatch_zone_mode",
  "weight_set_ref"       TEXT,
  "tickets_considered"   INTEGER             NOT NULL DEFAULT 0,
  "recommended"          INTEGER             NOT NULL DEFAULT 0,
  "unassignable"         INTEGER             NOT NULL DEFAULT 0,
  "unassignable_reasons" JSONB,
  "schedules"            INTEGER             NOT NULL DEFAULT 0,
  "batches"              INTEGER             NOT NULL DEFAULT 0,
  "tickets_dispatched"   INTEGER             NOT NULL DEFAULT 0,
  "error"                TEXT,
  "started_at"           TIMESTAMPTZ(6)      NOT NULL,
  "finished_at"          TIMESTAMPTZ(6),
  CONSTRAINT "dispatch_run_zones_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "dispatch_run_zones_run_id_zone_id_key" ON "dispatch_run_zones"("run_id", "zone_id");
CREATE INDEX "dispatch_run_zones_zone_id_idx" ON "dispatch_run_zones"("zone_id");

CREATE TABLE "dispatch_decision_traces" (
  "trace_id"          BIGSERIAL      NOT NULL,
  "run_id"            BIGINT         NOT NULL,
  "recommendation_id" BIGINT         NOT NULL,
  "ticket_id"         UUID           NOT NULL,
  "zone_id"           BIGINT         NOT NULL,
  "se_id"             UUID,
  "trace"             JSONB          NOT NULL,
  "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dispatch_decision_traces_pkey" PRIMARY KEY ("trace_id")
);

CREATE UNIQUE INDEX "dispatch_decision_traces_recommendation_id_key" ON "dispatch_decision_traces"("recommendation_id");
CREATE INDEX "dispatch_decision_traces_run_id_zone_id_idx" ON "dispatch_decision_traces"("run_id", "zone_id");
CREATE INDEX "dispatch_decision_traces_ticket_id_idx" ON "dispatch_decision_traces"("ticket_id");

ALTER TABLE "recommendations" ADD COLUMN "run_id" BIGINT;
CREATE INDEX "recommendations_run_id_idx" ON "recommendations"("run_id");

ALTER TABLE "work_schedules" ADD COLUMN "run_id" BIGINT;
CREATE INDEX "work_schedules_run_id_idx" ON "work_schedules"("run_id");

ALTER TABLE "dispatch_run_zones"
  ADD CONSTRAINT "dispatch_run_zones_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "dispatch_runs"("run_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dispatch_run_zones"
  ADD CONSTRAINT "dispatch_run_zones_zone_id_fkey"
  FOREIGN KEY ("zone_id") REFERENCES "zones"("zone_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "dispatch_decision_traces"
  ADD CONSTRAINT "dispatch_decision_traces_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "dispatch_runs"("run_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dispatch_decision_traces"
  ADD CONSTRAINT "dispatch_decision_traces_recommendation_id_fkey"
  FOREIGN KEY ("recommendation_id") REFERENCES "recommendations"("recommendation_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dispatch_decision_traces"
  ADD CONSTRAINT "dispatch_decision_traces_ticket_id_fkey"
  FOREIGN KEY ("ticket_id") REFERENCES "tickets"("ticket_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dispatch_decision_traces"
  ADD CONSTRAINT "dispatch_decision_traces_se_id_fkey"
  FOREIGN KEY ("se_id") REFERENCES "engineer_master"("engineer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "recommendations"
  ADD CONSTRAINT "recommendations_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "dispatch_runs"("run_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "work_schedules"
  ADD CONSTRAINT "work_schedules_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "dispatch_runs"("run_id") ON DELETE RESTRICT ON UPDATE CASCADE;
