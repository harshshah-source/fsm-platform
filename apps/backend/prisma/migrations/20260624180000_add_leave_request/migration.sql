-- Issue 26, slice 1 — SE-initiated Leave Request (CONTEXT §SE Availability, Decisions §SE leave).
-- The SE files ON_LEAVE / WEEKLY_OFF for a date range; the Zonal Manager approves (writing an
-- se_availability window, linked via availability_id) or rejects with a reason. A rejected request
-- can be revised + resubmitted as a new row.

CREATE TYPE "leave_request_type" AS ENUM ('ON_LEAVE', 'WEEKLY_OFF');
CREATE TYPE "leave_request_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE "leave_requests" (
    "id" BIGSERIAL NOT NULL,
    "se_id" UUID NOT NULL,
    "type" "leave_request_type" NOT NULL,
    "status" "leave_request_status" NOT NULL DEFAULT 'PENDING',
    "window_start" TIMESTAMPTZ(6) NOT NULL,
    "window_end" TIMESTAMPTZ(6) NOT NULL,
    "reason" TEXT,
    "decision_reason" TEXT,
    "decided_by" UUID,
    "decided_by_role" TEXT,
    "decided_at" TIMESTAMPTZ(6),
    "availability_id" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "leave_requests_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_window_order"
    CHECK ("window_end" >= "window_start");
CREATE INDEX "leave_requests_se_id_created_at_idx" ON "leave_requests"("se_id", "created_at" DESC);
CREATE INDEX "leave_requests_status_idx" ON "leave_requests"("status");

ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_se_id_fkey"
    FOREIGN KEY ("se_id") REFERENCES "engineer_master"("engineer_id") ON DELETE RESTRICT ON UPDATE CASCADE;
