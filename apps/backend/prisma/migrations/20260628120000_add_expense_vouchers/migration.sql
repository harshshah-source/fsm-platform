-- Issue 38 — Expense Vouchers end-to-end (schema D15, CONTEXT §Expense Vouchers). Two new tables:
-- `expense_vouchers` (header, one per SE reimbursement claim) and `expense_voucher_items` (line items).
-- The SE drafts offline on mobile with a draft-time `client_submission_id` (dedup scope
-- `(se_id, client_submission_id)`, mirroring `troubleshooting_submissions`). The header FKs `se_id` to
-- `engineer_master(engineer_id)` so the referenced user is always a SERVICE_ENGINEER; optional
-- Ticket/Plant/Vehicle links give the ZM activity-check context. Status flow
-- DRAFT → SUBMITTED → ZONAL_MANAGER_REVIEW → APPROVED | REJECTED | NEEDS_CLARIFICATION → PAID.

CREATE TYPE "voucher_status" AS ENUM (
  'DRAFT',
  'SUBMITTED',
  'ZONAL_MANAGER_REVIEW',
  'APPROVED',
  'REJECTED',
  'NEEDS_CLARIFICATION',
  'PAID'
);

CREATE TYPE "expense_category" AS ENUM (
  'TRAVEL',
  'ACCOMMODATION',
  'PARTS',
  'TOOLS',
  'MEAL',
  'OTHER'
);

CREATE TABLE "expense_vouchers" (
  "voucher_id"           UUID            NOT NULL DEFAULT gen_random_uuid(),
  "se_id"                UUID            NOT NULL,
  "client_submission_id" UUID            NOT NULL,
  "status"               "voucher_status" NOT NULL DEFAULT 'DRAFT',
  "plant_id"             BIGINT,
  "ticket_id"            UUID,
  "vehicle_id"           BIGINT,
  "total_amount"         DECIMAL(12, 2)  NOT NULL DEFAULT 0,
  "submitted_at"         TIMESTAMPTZ(6),
  "reviewed_by"          UUID,
  "reviewed_at"          TIMESTAMPTZ(6),
  "review_notes"         TEXT,
  "paid_batch_ref"       TEXT,
  "paid_at"              TIMESTAMPTZ(6),
  "created_at"           TIMESTAMPTZ(6)  NOT NULL DEFAULT now(),
  "updated_at"           TIMESTAMPTZ(6)  NOT NULL,
  CONSTRAINT "expense_vouchers_pkey" PRIMARY KEY ("voucher_id")
);

CREATE TABLE "expense_voucher_items" (
  "item_id"              BIGSERIAL       NOT NULL,
  "voucher_id"           UUID            NOT NULL,
  "category"             "expense_category" NOT NULL,
  "amount"               DECIMAL(12, 2)  NOT NULL,
  "merchant_vendor_name" TEXT,
  "expense_datetime"     TIMESTAMPTZ(6),
  "photo_ref"            TEXT,
  "created_at"           TIMESTAMPTZ(6)  NOT NULL DEFAULT now(),
  "updated_at"           TIMESTAMPTZ(6)  NOT NULL,
  CONSTRAINT "expense_voucher_items_pkey" PRIMARY KEY ("item_id"),
  CONSTRAINT "expense_voucher_items_amount_nonneg" CHECK ("amount" >= 0)
);

CREATE UNIQUE INDEX "expense_vouchers_se_id_client_submission_id_key"
  ON "expense_vouchers"("se_id", "client_submission_id");

CREATE INDEX "expense_vouchers_status_submitted_at_idx"
  ON "expense_vouchers"("status", "submitted_at");

CREATE INDEX "expense_voucher_items_voucher_id_idx"
  ON "expense_voucher_items"("voucher_id");

ALTER TABLE "expense_vouchers"
  ADD CONSTRAINT "expense_vouchers_se_id_fkey"
  FOREIGN KEY ("se_id") REFERENCES "engineer_master"("engineer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "expense_voucher_items"
  ADD CONSTRAINT "expense_voucher_items_voucher_id_fkey"
  FOREIGN KEY ("voucher_id") REFERENCES "expense_vouchers"("voucher_id") ON DELETE CASCADE ON UPDATE CASCADE;
