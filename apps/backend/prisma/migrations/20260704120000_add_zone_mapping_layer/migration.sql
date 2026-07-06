-- R6 translation layer — FSM-owned, admin-editable value→zone crosswalk (additive / non-breaking).
-- Replaces the hardcoded state→zone code map with data: AutoPlant stays the source of truth for the
-- RAW value (mst_plant.zone_name); FSM owns the OPERATIONAL mapping to a Zone. Same posture as
-- sla_rule_config / priority_rule_config (Ops-Head-owned config lives in tables, not code).
--
-- NO change to plants.zone_id nullability: pending/ambiguous values land the plant in the seeded
-- UNZONED holding zone (a real zones row), so the ~16-call-site nullable migration stays unneeded.
-- Master-sync is insert-only on plants.zone_id (anti-drift); edits here take effect via the FSM-owned
-- re-apply operation (ZoneMappingService.reapply), never by a re-sync clobbering the operational zone.

-- ── zone_mapping_status enum ──────────────────────────────────────────────────────────────────────
CREATE TYPE "zone_mapping_status" AS ENUM ('PENDING', 'MAPPED', 'IGNORED');

-- ── zone_mappings: the admin-owned value→zone crosswalk ───────────────────────────────────────────
CREATE TABLE "zone_mappings" (
  "id"               BIGSERIAL             NOT NULL,
  "source_field"     TEXT                  NOT NULL,
  "source_value_key" TEXT                  NOT NULL,
  "source_value_raw" TEXT,
  "fsm_zone_id"      BIGINT,
  "status"           "zone_mapping_status" NOT NULL DEFAULT 'PENDING',
  "seen_count"       INTEGER               NOT NULL DEFAULT 0,
  "last_seen_at"     TIMESTAMPTZ(6),
  "created_by"       UUID,
  "updated_by"       UUID,
  "created_at"       TIMESTAMPTZ(6)        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMPTZ(6)        NOT NULL,
  CONSTRAINT "zone_mappings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "zone_mappings_source_field_source_value_key_key"
  ON "zone_mappings"("source_field", "source_value_key");
CREATE INDEX "zone_mappings_status_idx" ON "zone_mappings"("status");
CREATE INDEX "zone_mappings_fsm_zone_id_idx" ON "zone_mappings"("fsm_zone_id");
ALTER TABLE "zone_mappings"
  ADD CONSTRAINT "zone_mappings_fsm_zone_id_fkey"
  FOREIGN KEY ("fsm_zone_id") REFERENCES "zones"("zone_id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ── plant_zone_overrides: per-plant escape hatch (highest-precedence resolver tier) ───────────────
CREATE TABLE "plant_zone_overrides" (
  "id"              BIGSERIAL      NOT NULL,
  "source_plant_id" BIGINT         NOT NULL,
  "fsm_zone_id"     BIGINT         NOT NULL,
  "reason"          TEXT,
  "created_by"      UUID,
  "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "plant_zone_overrides_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "plant_zone_overrides_source_plant_id_key"
  ON "plant_zone_overrides"("source_plant_id");
CREATE INDEX "plant_zone_overrides_fsm_zone_id_idx" ON "plant_zone_overrides"("fsm_zone_id");
ALTER TABLE "plant_zone_overrides"
  ADD CONSTRAINT "plant_zone_overrides_fsm_zone_id_fkey"
  FOREIGN KEY ("fsm_zone_id") REFERENCES "zones"("zone_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
