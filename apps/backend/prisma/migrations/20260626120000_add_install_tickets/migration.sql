-- Issue 33 — Install Ticket create (single + CSV, scoped). Additive on `tickets`: the manual-creation
-- actor (`created_by` + `created_by_role`), the creation channel (`install_trigger_source`; v1 is
-- MANUAL_OPERATIONS, the v2 External Order Webhook will use EXTERNAL_API — both defined now per
-- ADR-0011), the CSV-bulk batch grouping (`install_batch_id`), and the optional CSV columns
-- (`install_sim_id` / `install_target_date` / `install_notes`). TROUBLESHOOT/RECOVERY rows leave these null.

CREATE TYPE "install_trigger_source" AS ENUM ('MANUAL_OPERATIONS', 'EXTERNAL_API');

ALTER TABLE "tickets"
  ADD COLUMN "created_by" UUID,
  ADD COLUMN "created_by_role" "role",
  ADD COLUMN "install_trigger_source" "install_trigger_source",
  ADD COLUMN "install_sim_id" TEXT,
  ADD COLUMN "install_target_date" DATE,
  ADD COLUMN "install_notes" TEXT,
  ADD COLUMN "install_batch_id" UUID;

CREATE INDEX "tickets_install_batch_id_idx" ON "tickets"("install_batch_id");
