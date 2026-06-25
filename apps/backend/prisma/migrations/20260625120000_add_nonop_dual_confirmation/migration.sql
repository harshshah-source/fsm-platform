-- Issue 35 — Non-Operational dual-confirmation marking (CONTEXT.md §14). Additive on the minimal
-- non_operational_markings table (Issue 05). Adds the reason code + effective window capture, the
-- dual-confirmation timestamps (manager + customer), the one-time customer token, the Operations-Head
-- 7-day override-confirm fields, and the auto-created Recovery-Ticket back-reference. `tickets` gains
-- a back-reference to the marking that closed (CLOSED_NON_OPERATIONAL) or created (RECOVERY) it.

CREATE TYPE "nonop_reason" AS ENUM (
  'VEHICLE_SCRAPPED', 'VEHICLE_SOLD', 'VEHICLE_ACCIDENT', 'COMPANY_PAUSED',
  'DEVICE_REPLACEMENT_PENDING', 'COMPLIANCE_HOLD', 'OTHER'
);

ALTER TABLE "non_operational_markings"
  ADD COLUMN "reason_code" "nonop_reason",
  ADD COLUMN "reason_text" TEXT,
  ADD COLUMN "deal_type_at_marking" "deal_type",
  ADD COLUMN "requested_by" UUID,
  ADD COLUMN "requested_by_role" "role",
  ADD COLUMN "awaiting_since" TIMESTAMPTZ(6),
  ADD COLUMN "manager_confirmed_at" TIMESTAMPTZ(6),
  ADD COLUMN "manager_confirmed_by" UUID,
  ADD COLUMN "customer_confirmed_at" TIMESTAMPTZ(6),
  ADD COLUMN "customer_token" TEXT,
  ADD COLUMN "customer_token_expires_at" TIMESTAMPTZ(6),
  ADD COLUMN "confirmed_at" TIMESTAMPTZ(6),
  ADD COLUMN "override_confirmed_by" UUID,
  ADD COLUMN "override_reason" TEXT,
  ADD COLUMN "recovery_ticket_id" UUID;

CREATE UNIQUE INDEX "non_operational_markings_customer_token_key"
  ON "non_operational_markings"("customer_token");
CREATE INDEX "non_operational_markings_state_awaiting_since_idx"
  ON "non_operational_markings"("state", "awaiting_since");

ALTER TABLE "tickets" ADD COLUMN "nonop_marking_id" UUID;
CREATE INDEX "tickets_nonop_marking_id_idx" ON "tickets"("nonop_marking_id");
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_nonop_marking_id_fkey"
  FOREIGN KEY ("nonop_marking_id") REFERENCES "non_operational_markings"("marking_id")
  ON DELETE SET NULL ON UPDATE CASCADE;
