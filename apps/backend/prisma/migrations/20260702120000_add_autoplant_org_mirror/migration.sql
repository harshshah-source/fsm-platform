-- Phase 2a — AutoPlant organization mirror + source reconciliation keys (additive / non-breaking).
-- Mirrors the AUTHORITATIVE ap_masters.mst_plant / mst_company / mst_transporter hierarchy as source
-- attributes, adds the source_*_id upsert keys, and the transporters + master_sync_runs tables.
-- NO device_id type change (that is Phase 2b). NO zone assignment / routing / ownership.
-- plants.zone_id stays NOT NULL here; relaxing it to nullable (for unzoned synced plants) is deferred
-- to Phase 4 (master-sync), where unzoned-plant behaviour is designed and its ~16 call-site ripples
-- through cross-zone/planner/override are handled deliberately.

-- ── company_master: AutoPlant customer mirror ────────────────────────────────────────────────────
ALTER TABLE "company_master"
  ADD COLUMN "source_company_id" BIGINT,
  ADD COLUMN "company_type"      TEXT,
  ADD COLUMN "status"            TEXT;
CREATE UNIQUE INDEX "company_master_source_company_id_key" ON "company_master"("source_company_id");

-- ── plants: AutoPlant org-hierarchy mirror attributes (zone_id nullability deferred to Phase 4) ────
ALTER TABLE "plants"
  ADD COLUMN "source_plant_id"    BIGINT,
  ADD COLUMN "source_zone_id"     BIGINT,
  ADD COLUMN "source_zone_name"   TEXT,
  ADD COLUMN "source_region_id"   BIGINT,
  ADD COLUMN "source_region_name" TEXT,
  ADD COLUMN "plant_state"        TEXT,
  ADD COLUMN "plant_district"     TEXT,
  ADD COLUMN "master_plant_id"    BIGINT,
  ADD COLUMN "master_plant_code"  TEXT,
  ADD COLUMN "status"             TEXT;
CREATE UNIQUE INDEX "plants_source_plant_id_key" ON "plants"("source_plant_id");

-- ── vehicles: AutoPlant deployment-status mirror (transporter FK deferred to Phase 4) ─────────────
ALTER TABLE "vehicles" ADD COLUMN "status" TEXT;

-- ── transporters: mirror of ap_masters.mst_transporter (standalone; vehicles FK wired in Phase 4) ──
CREATE TABLE "transporters" (
  "transporter_id"        BIGSERIAL      NOT NULL,
  "source_transporter_id" BIGINT,
  "name"                  TEXT           NOT NULL,
  "company_id"            BIGINT,
  "status"                TEXT,
  "created_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "transporters_pkey" PRIMARY KEY ("transporter_id")
);
CREATE UNIQUE INDEX "transporters_source_transporter_id_key" ON "transporters"("source_transporter_id");
CREATE INDEX "transporters_company_id_idx" ON "transporters"("company_id");

-- ── master_sync_runs: master-sync bookkeeping (mirrors snapshot_runs) ─────────────────────────────
CREATE TABLE "master_sync_runs" (
  "run_id"       BIGSERIAL      NOT NULL,
  "started_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at"  TIMESTAMPTZ(6),
  "status"       TEXT           NOT NULL DEFAULT 'RUNNING',
  "entity_stats" JSONB,
  "error"        TEXT,
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "master_sync_runs_pkey" PRIMARY KEY ("run_id")
);
