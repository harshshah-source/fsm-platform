-- Issue 24, slice 1 — the inventory ledger (CONTEXT §Inventory / §Shadow Use). One row per component
-- movement on a Ticket. `type` = accounting category; `status` = lifecycle (PRE_VERIFICATION →
-- DEDUCTED | ROLLED_BACK, or SHADOW_USE → RECONCILED | DISPUTED).

CREATE TYPE "inventory_txn_type" AS ENUM ('TICKET_CONSUMPTION', 'FAULTY_COMPONENT_RETURNED');
CREATE TYPE "inventory_txn_status" AS ENUM (
  'PRE_VERIFICATION', 'DEDUCTED', 'ROLLED_BACK', 'SHADOW_USE', 'RECONCILED', 'DISPUTED'
);

CREATE TABLE "inventory_transactions" (
    "id" BIGSERIAL NOT NULL,
    "se_id" UUID NOT NULL,
    "component_id" BIGINT NOT NULL,
    "qty" INTEGER NOT NULL,
    "ticket_id" UUID,
    "submission_id" UUID,
    "type" "inventory_txn_type" NOT NULL,
    "status" "inventory_txn_status" NOT NULL,
    "reason" TEXT,
    "reconciled_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "inventory_transactions_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_qty_positive" CHECK ("qty" > 0);
CREATE INDEX "inventory_transactions_status_idx" ON "inventory_transactions"("status");
CREATE INDEX "inventory_transactions_ticket_id_idx" ON "inventory_transactions"("ticket_id");
CREATE INDEX "inventory_transactions_se_id_idx" ON "inventory_transactions"("se_id");

ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_se_id_fkey"
    FOREIGN KEY ("se_id") REFERENCES "engineer_master"("engineer_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_component_id_fkey"
    FOREIGN KEY ("component_id") REFERENCES "component_master"("component_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_ticket_id_fkey"
    FOREIGN KEY ("ticket_id") REFERENCES "tickets"("ticket_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_submission_id_fkey"
    FOREIGN KEY ("submission_id") REFERENCES "troubleshooting_submissions"("submission_id") ON DELETE RESTRICT ON UPDATE CASCADE;
