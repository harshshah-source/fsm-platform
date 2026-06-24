-- Issue 18, slice 1 — verification_runs (schema D14). Three-phase auto-GPS verification of recovery
-- pings; fraud flag; PARTIAL_RECOVERY badge source. The one-in-flight-per-ticket partial unique
-- (ux_vr_active) is raw SQL (not Prisma-expressible).

CREATE TYPE "verify_phase" AS ENUM ('PENDING', 'PHASE_1_PASS', 'PHASE_2_PASS');
CREATE TYPE "verify_outcome" AS ENUM (
  'CLOSED', 'FAILED_VERIFICATION', 'PARTIAL_RECOVERY', 'CLOSED_AUTO_RECOVERY', 'FAILED_ACTIVATION'
);

CREATE TABLE "verification_runs" (
    "run_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ticket_id" UUID NOT NULL,
    "submission_id" UUID,
    "device_id" BIGINT NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "se_gps_lat" DOUBLE PRECISION,
    "se_gps_lon" DOUBLE PRECISION,
    "phase" "verify_phase" NOT NULL DEFAULT 'PENDING',
    "phase1_passed_at" TIMESTAMPTZ(6),
    "phase2_passed_at" TIMESTAMPTZ(6),
    "first_ping_distance_meters" DECIMAL(12, 2),
    "fraud_flag" BOOLEAN NOT NULL DEFAULT false,
    "pings_received_count" INTEGER NOT NULL DEFAULT 0,
    "outcome" "verify_outcome",
    "outcome_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "verification_runs_pkey" PRIMARY KEY ("run_id")
);

CREATE INDEX "verification_runs_device_id_idx" ON "verification_runs"("device_id");
-- I22 — one in-flight verification run per ticket (re-entrant 5-min worker can't double-open).
CREATE UNIQUE INDEX "ux_vr_active" ON "verification_runs"("ticket_id") WHERE "outcome" IS NULL;

ALTER TABLE "verification_runs" ADD CONSTRAINT "verification_runs_ticket_id_fkey"
    FOREIGN KEY ("ticket_id") REFERENCES "tickets"("ticket_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "verification_runs" ADD CONSTRAINT "verification_runs_submission_id_fkey"
    FOREIGN KEY ("submission_id") REFERENCES "troubleshooting_submissions"("submission_id") ON DELETE RESTRICT ON UPDATE CASCADE;
