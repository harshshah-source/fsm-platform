-- Issue 36 — Recovery Ticket field workflow (CONTEXT.md §14). Additive on `tickets`: the RECOVERY
-- assignee, the Collection-Form capture (confirmed device serial + condition notes), the SE
-- "Unable to Collect" reason that routes to the ZM decision queue (Issue 37), and the closure
-- classification (`closure_type` / reason / closed_at). Issue 36 sets only
-- AUTO_CLOSED_ON_WAREHOUSE_RECEIPT; the manual/failed closure types are defined now for Issue 37.

CREATE TYPE "closure_type" AS ENUM (
  'AUTO_CLOSED_ON_WAREHOUSE_RECEIPT', 'FAILED_RECOVERY_CLOSE', 'ZM_MANUAL_CLOSE',
  'OPERATIONS_HEAD_OVERRIDE_CLOSE', 'CSM_ACTING_CLOSE'
);
CREATE TYPE "unable_to_collect_reason" AS ENUM (
  'COMPANY_REFUSED', 'VEHICLE_UNREACHABLE', 'DEVICE_MISSING', 'OTHER'
);

ALTER TABLE "tickets"
  ADD COLUMN "assigned_se_id" UUID,
  ADD COLUMN "collected_device_serial" TEXT,
  ADD COLUMN "collection_condition_notes" TEXT,
  ADD COLUMN "unable_to_collect_reason" "unable_to_collect_reason",
  ADD COLUMN "unable_to_collect_at" TIMESTAMPTZ(6),
  ADD COLUMN "closure_type" "closure_type",
  ADD COLUMN "closure_reason" TEXT,
  ADD COLUMN "closed_at" TIMESTAMPTZ(6);

CREATE INDEX "tickets_assigned_se_id_idx" ON "tickets"("assigned_se_id");
