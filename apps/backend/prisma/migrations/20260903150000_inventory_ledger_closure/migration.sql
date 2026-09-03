-- #353 — inventory ledger closure. Two new lifecycle states and a device key, so the two places the
-- ledger used to stop short of the truth can be written down:
--
--   SHADOW_USE_DISPUTE_RESTORE  the compensating row for a disputed shadow use. The DISPUTED row is
--                               the Warehouse Manager's decision and stays; this row is the part
--                               going back into the losing SE's van, so the correction is readable
--                               instead of an unexplained se_van_stock increment.
--   RECOVERY_RECEIPT            a recovered device confirmed received at the zone warehouse. Keyed by
--                               device, not by component: a device is not a SKU movement, and under
--                               INV-G2's default it maps to no component and moves no stock.
--
-- `se_id` and `component_id` become nullable for exactly that row shape — a device arriving at the
-- warehouse belongs to no van, and maps to a component only when one is named for its device_type.
-- Every existing row keeps both. The new CHECK keeps the table honest: a ledger row accounts for an
-- engineer's stock or for a device, never for neither.

ALTER TYPE "inventory_txn_status" ADD VALUE IF NOT EXISTS 'SHADOW_USE_DISPUTE_RESTORE';
ALTER TYPE "inventory_txn_status" ADD VALUE IF NOT EXISTS 'RECOVERY_RECEIPT';

ALTER TABLE "inventory_transactions" ALTER COLUMN "se_id" DROP NOT NULL;
ALTER TABLE "inventory_transactions" ALTER COLUMN "component_id" DROP NOT NULL;
ALTER TABLE "inventory_transactions" ADD COLUMN "device_id" TEXT;

ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_device_id_fkey"
    FOREIGN KEY ("device_id") REFERENCES "devices"("device_id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "inventory_transactions_device_id_idx" ON "inventory_transactions"("device_id");

ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_keyed"
    CHECK ("se_id" IS NOT NULL OR "device_id" IS NOT NULL);
