-- Issue 22, slice 1 — Component Request (ADR-0008, CONTEXT §8). Raised when an SE submits a
-- Troubleshoot form with component_unavailable=true; routes to the Warehouse Manager. v1 lifecycle
-- REQUESTED → APPROVED | REJECTED → SHIPPED → RECEIVED. One request per raising submission.

CREATE TYPE "component_request_status" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'SHIPPED', 'RECEIVED');
CREATE TYPE "delivery_destination" AS ENUM ('SE_LOCATION', 'PLANT_WAREHOUSE');

CREATE TABLE "component_request" (
    "request_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "failure_cycle_id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "se_id" UUID NOT NULL,
    "component_id" BIGINT,
    "status" "component_request_status" NOT NULL DEFAULT 'REQUESTED',
    "delivery_destination" "delivery_destination",
    "tracking_ref" TEXT,
    "rejection_reason" TEXT,
    "wm_actor_id" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "shipped_at" TIMESTAMPTZ(6),
    "rejected_at" TIMESTAMPTZ(6),
    "received_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "component_request_pkey" PRIMARY KEY ("request_id")
);

-- One request per raising submission (idempotent raise from the troubleshoot submission).
CREATE UNIQUE INDEX "component_request_submission_id_key" ON "component_request"("submission_id");
CREATE INDEX "component_request_status_created_at_idx" ON "component_request"("status", "created_at");
CREATE INDEX "component_request_ticket_id_created_at_idx" ON "component_request"("ticket_id", "created_at" DESC);

ALTER TABLE "component_request" ADD CONSTRAINT "component_request_ticket_id_fkey"
    FOREIGN KEY ("ticket_id") REFERENCES "tickets"("ticket_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "component_request" ADD CONSTRAINT "component_request_failure_cycle_id_fkey"
    FOREIGN KEY ("failure_cycle_id") REFERENCES "failure_cycles"("cycle_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "component_request" ADD CONSTRAINT "component_request_submission_id_fkey"
    FOREIGN KEY ("submission_id") REFERENCES "troubleshooting_submissions"("submission_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "component_request" ADD CONSTRAINT "component_request_se_id_fkey"
    FOREIGN KEY ("se_id") REFERENCES "engineer_master"("engineer_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "component_request" ADD CONSTRAINT "component_request_component_id_fkey"
    FOREIGN KEY ("component_id") REFERENCES "component_master"("component_id") ON DELETE RESTRICT ON UPDATE CASCADE;
