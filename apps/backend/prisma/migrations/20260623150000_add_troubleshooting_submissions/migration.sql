-- Issue 16, slice 1 — troubleshooting_submissions (schema D11). SE form submission: structured root
-- cause (the analytics source), silent SE GPS anchor, storage-level idempotency. CHECKs + the geometry
-- column + the DESC index are raw SQL (not Prisma-expressible / Unsupported type).

CREATE TYPE "submission_type" AS ENUM ('TROUBLESHOOTING_FORM', 'EXPENSE_VOUCHER', 'COMPONENT_REQUEST', 'COMPONENT_RESUBMIT');
CREATE TYPE "presence_source" AS ENUM ('GEOFENCE_AUTO', 'MANUAL_ONSITE', 'FORM_GPS', 'NONE');
CREATE TYPE "root_cause_category" AS ENUM (
  'POWER_ISSUE', 'SIM_NETWORK_ISSUE', 'GPS_ANTENNA_ISSUE', 'DEVICE_HARDWARE_FAULT', 'WIRING_ISSUE',
  'CONFIGURATION_ISSUE', 'VEHICLE_ACCESS_ISSUE', 'INSTALLATION_ISSUE', 'CUSTOMER_SIDE_ISSUE', 'UNKNOWN'
);

CREATE TABLE "troubleshooting_submissions" (
    "submission_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ticket_id" UUID NOT NULL,
    "failure_cycle_id" UUID NOT NULL,
    "submission_type" "submission_type" NOT NULL,
    "client_submission_id" UUID NOT NULL,
    "se_id" UUID NOT NULL,
    "se_gps_lat" DOUBLE PRECISION,
    "se_gps_lon" DOUBLE PRECISION,
    "presence_source" "presence_source" NOT NULL,
    "onsite_capture_gps" geometry(Point, 4326),
    "component_unavailable" BOOLEAN NOT NULL DEFAULT false,
    "component_unavailable_item" BIGINT,
    "root_cause_category" "root_cause_category" NOT NULL,
    "root_cause_subcategory" TEXT,
    "root_cause_notes" TEXT,
    "action_taken_category" TEXT,
    "action_taken_notes" TEXT,
    "diagnosis_notes" TEXT,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL,
    "photo_refs" TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "troubleshooting_submissions_pkey" PRIMARY KEY ("submission_id")
);

-- Storage-level idempotency: a retry with the same client id never creates a second record.
CREATE UNIQUE INDEX "troubleshooting_submissions_se_id_client_submission_id_key"
    ON "troubleshooting_submissions"("se_id", "client_submission_id");
-- Latest submission per ticket (verification anchor read).
CREATE INDEX "troubleshooting_submissions_ticket_id_submitted_at_idx"
    ON "troubleshooting_submissions"("ticket_id", "submitted_at" DESC);
CREATE INDEX "troubleshooting_submissions_failure_cycle_id_idx"
    ON "troubleshooting_submissions"("failure_cycle_id");
-- Feeds RootCauseSummaryWorker / Root Cause Analytics.
CREATE INDEX "troubleshooting_submissions_root_cause_category_submitted_at_idx"
    ON "troubleshooting_submissions"("root_cause_category", "submitted_at");

-- component_unavailable must name the awaited part.
ALTER TABLE "troubleshooting_submissions" ADD CONSTRAINT "ts_submissions_component_unavailable_item"
    CHECK ("component_unavailable" = false OR "component_unavailable_item" IS NOT NULL);
-- This table holds only the two form submission types.
ALTER TABLE "troubleshooting_submissions" ADD CONSTRAINT "ts_submissions_form_type_only"
    CHECK ("submission_type" IN ('TROUBLESHOOTING_FORM', 'COMPONENT_RESUBMIT'));

ALTER TABLE "troubleshooting_submissions" ADD CONSTRAINT "troubleshooting_submissions_ticket_id_fkey"
    FOREIGN KEY ("ticket_id") REFERENCES "tickets"("ticket_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "troubleshooting_submissions" ADD CONSTRAINT "troubleshooting_submissions_failure_cycle_id_fkey"
    FOREIGN KEY ("failure_cycle_id") REFERENCES "failure_cycles"("cycle_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "troubleshooting_submissions" ADD CONSTRAINT "troubleshooting_submissions_se_id_fkey"
    FOREIGN KEY ("se_id") REFERENCES "engineer_master"("engineer_id") ON DELETE RESTRICT ON UPDATE CASCADE;
