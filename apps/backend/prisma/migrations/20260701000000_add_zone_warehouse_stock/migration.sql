-- CreateTable: per-zone warehouse stock levels (Issue 73)
CREATE TABLE "zone_warehouse_stock" (
    "id" BIGSERIAL NOT NULL,
    "zone_id" BIGINT NOT NULL,
    "component_id" BIGINT NOT NULL,
    "on_hand" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "low_stock_threshold" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "zone_warehouse_stock_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "zone_warehouse_stock_zone_id_component_id_key" ON "zone_warehouse_stock"("zone_id", "component_id");
CREATE INDEX "zone_warehouse_stock_component_id_idx" ON "zone_warehouse_stock"("component_id");

ALTER TABLE "zone_warehouse_stock" ADD CONSTRAINT "zone_warehouse_stock_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "zones"("zone_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "zone_warehouse_stock" ADD CONSTRAINT "zone_warehouse_stock_component_id_fkey" FOREIGN KEY ("component_id") REFERENCES "component_master"("component_id") ON DELETE RESTRICT ON UPDATE CASCADE;
