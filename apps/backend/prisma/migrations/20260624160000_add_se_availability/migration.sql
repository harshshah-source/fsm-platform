-- Issue 25, slice 1 — time-windowed SE availability (ADR-0010, CONTEXT §SE Availability). One row per
-- availability window; window_end null = open-ended. The current status is the active window's status
-- (else AVAILABLE). Only AVAILABLE lets the Recommender include the SE.

CREATE TYPE "se_availability_status" AS ENUM (
  'AVAILABLE', 'ON_LEAVE', 'OFF_SHIFT', 'WEEKLY_OFF', 'SOFT_UNAVAILABLE', 'OFFLINE'
);

CREATE TABLE "se_availability" (
    "id" BIGSERIAL NOT NULL,
    "se_id" UUID NOT NULL,
    "status" "se_availability_status" NOT NULL,
    "window_start" TIMESTAMPTZ(6) NOT NULL,
    "window_end" TIMESTAMPTZ(6),
    "reason" TEXT,
    "set_by" UUID,
    "set_by_role" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "se_availability_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "se_availability" ADD CONSTRAINT "se_availability_window_order"
    CHECK ("window_end" IS NULL OR "window_end" >= "window_start");
CREATE INDEX "se_availability_se_id_window_start_idx" ON "se_availability"("se_id", "window_start" DESC);

ALTER TABLE "se_availability" ADD CONSTRAINT "se_availability_se_id_fkey"
    FOREIGN KEY ("se_id") REFERENCES "engineer_master"("engineer_id") ON DELETE RESTRICT ON UPDATE CASCADE;
