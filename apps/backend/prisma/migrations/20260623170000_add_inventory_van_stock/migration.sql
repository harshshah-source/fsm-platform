-- Issue 21, slice 1 — inventory core (schema D12). component_master, se_van_stock (the Common-Kit
-- source), the common_kit_definition FK, and component_blocked_queue (tickets dropped for a missing
-- Common Kit). CHECKs + the active-row partial unique are raw SQL.

CREATE TABLE "component_master" (
    "component_id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "serial_tracked" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "component_master_pkey" PRIMARY KEY ("component_id")
);
CREATE UNIQUE INDEX "component_master_name_key" ON "component_master"("name");

CREATE TABLE "se_van_stock" (
    "id" BIGSERIAL NOT NULL,
    "se_id" UUID NOT NULL,
    "component_id" BIGINT NOT NULL,
    "qty" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "se_van_stock_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "se_van_stock_se_id_component_id_key" ON "se_van_stock"("se_id", "component_id");
ALTER TABLE "se_van_stock" ADD CONSTRAINT "se_van_stock_qty_nonneg" CHECK ("qty" >= 0);

CREATE TABLE "component_blocked_queue" (
    "id" BIGSERIAL NOT NULL,
    "ticket_id" UUID NOT NULL,
    "se_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "missing_components" JSONB NOT NULL,
    "wm_action_status" TEXT NOT NULL DEFAULT 'PENDING',
    "blocked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),
    CONSTRAINT "component_blocked_queue_pkey" PRIMARY KEY ("id")
);
-- One active block per ticket (a re-run refreshes, not duplicates).
CREATE UNIQUE INDEX "ux_cbq_active" ON "component_blocked_queue"("ticket_id") WHERE "resolved_at" IS NULL;
CREATE INDEX "component_blocked_queue_blocked_at_idx" ON "component_blocked_queue"("blocked_at");

ALTER TABLE "se_van_stock" ADD CONSTRAINT "se_van_stock_se_id_fkey"
    FOREIGN KEY ("se_id") REFERENCES "engineer_master"("engineer_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "se_van_stock" ADD CONSTRAINT "se_van_stock_component_id_fkey"
    FOREIGN KEY ("component_id") REFERENCES "component_master"("component_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill placeholder component_master rows for any pre-existing common_kit_definition component_ids
-- (dev-DB leftovers) so the deferred FK can attach without orphan violations.
INSERT INTO "component_master" ("component_id", "name")
SELECT DISTINCT ckd."component_id", 'component-' || ckd."component_id"
FROM "common_kit_definition" ckd
WHERE NOT EXISTS (SELECT 1 FROM "component_master" cm WHERE cm."component_id" = ckd."component_id");
SELECT setval(pg_get_serial_sequence('component_master', 'component_id'),
              GREATEST((SELECT COALESCE(MAX("component_id"), 1) FROM "component_master"), 1));

-- Backfill the deferred common_kit_definition FK (Issue 21).
ALTER TABLE "common_kit_definition" ADD CONSTRAINT "common_kit_definition_component_id_fkey"
    FOREIGN KEY ("component_id") REFERENCES "component_master"("component_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "component_blocked_queue" ADD CONSTRAINT "component_blocked_queue_ticket_id_fkey"
    FOREIGN KEY ("ticket_id") REFERENCES "tickets"("ticket_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "component_blocked_queue" ADD CONSTRAINT "component_blocked_queue_se_id_fkey"
    FOREIGN KEY ("se_id") REFERENCES "engineer_master"("engineer_id") ON DELETE RESTRICT ON UPDATE CASCADE;
