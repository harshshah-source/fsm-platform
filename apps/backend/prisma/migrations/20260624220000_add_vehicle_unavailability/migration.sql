-- Issue 28, slice 1 — Vehicle Unavailability Report + dual SLA clocks. On submit the primary SLA
-- pauses (pause_reason = VEHICLE_UNAVAILABLE on the Failure Cycle) and the Ticket resurfaces at the
-- expected-availability date. The Secondary SLA Clock is derived (failure_cycles.opened_at), not stored.

CREATE TYPE "vehicle_unavail_reason" AS ENUM (
  'VEHICLE_ON_TRIP', 'VEHICLE_NOT_AT_PLANT', 'DRIVER_NOT_AVAILABLE', 'CUSTOMER_REFUSED', 'OTHER'
);
CREATE TYPE "vehicle_unavail_status" AS ENUM ('OPEN', 'RESOLVED');

CREATE TABLE "vehicle_unavailability_reports" (
    "id" BIGSERIAL NOT NULL,
    "ticket_id" UUID NOT NULL,
    "failure_cycle_id" UUID,
    "se_id" UUID NOT NULL,
    "reason_code" "vehicle_unavail_reason" NOT NULL,
    "transporter_contacted" BOOLEAN NOT NULL DEFAULT false,
    "expected_from" TIMESTAMPTZ(6) NOT NULL,
    "expected_to" TIMESTAMPTZ(6),
    "notes" TEXT,
    "gps_lat" DOUBLE PRECISION,
    "gps_lng" DOUBLE PRECISION,
    "status" "vehicle_unavail_status" NOT NULL DEFAULT 'OPEN',
    "resolved_by" UUID,
    "resolved_by_role" TEXT,
    "resolved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "vehicle_unavailability_reports_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "vehicle_unavailability_reports" ADD CONSTRAINT "vehicle_unavail_window_order"
    CHECK ("expected_to" IS NULL OR "expected_to" >= "expected_from");
CREATE INDEX "vehicle_unavail_ticket_idx" ON "vehicle_unavailability_reports"("ticket_id");
CREATE INDEX "vehicle_unavail_status_expected_idx" ON "vehicle_unavailability_reports"("status", "expected_from");

ALTER TABLE "vehicle_unavailability_reports" ADD CONSTRAINT "vehicle_unavail_ticket_fkey"
    FOREIGN KEY ("ticket_id") REFERENCES "tickets"("ticket_id") ON DELETE RESTRICT ON UPDATE CASCADE;
