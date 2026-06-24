-- CreateTable
CREATE TABLE "sla_rule_config" (
    "id" BIGSERIAL NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "submit_within_minutes" INTEGER,
    "verify_within_minutes" INTEGER,
    "escalate_after_minutes" INTEGER,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sla_rule_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "priority_rule_config" (
    "id" BIGSERIAL NOT NULL,
    "weight_set_ref" TEXT NOT NULL,
    "component" TEXT NOT NULL,
    "weight" DECIMAL(10,4) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "effective_from" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "priority_rule_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "common_kit_definition" (
    "id" BIGSERIAL NOT NULL,
    "component_id" BIGINT NOT NULL,
    "min_qty" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "common_kit_definition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sla_rule_config_scope_key_key" ON "sla_rule_config"("scope", "key");

-- CreateIndex
CREATE INDEX "priority_rule_config_weight_set_ref_active_idx" ON "priority_rule_config"("weight_set_ref", "active");

-- CreateIndex
CREATE UNIQUE INDEX "priority_rule_config_weight_set_ref_component_key" ON "priority_rule_config"("weight_set_ref", "component");

-- CreateIndex
CREATE UNIQUE INDEX "common_kit_definition_component_id_key" ON "common_kit_definition"("component_id");

-- Schema D12: positive Common Kit minimum.
ALTER TABLE "common_kit_definition" ADD CONSTRAINT "common_kit_min_qty_chk" CHECK ("min_qty" > 0);
