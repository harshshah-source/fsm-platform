-- Issue 97 Slice 4 (review A5) — itemised master-sync skip accounting (additive / non-breaking).
-- `entity_stats` skip counters said only "vehicles: {skipped: 3200}"; this table enumerates WHICH
-- source rows were skipped and WHY, one row per (run, entity, natural key, reason), so an operator
-- can itemise a run's skips with a single indexed query instead of re-reading the capped source.

-- CreateTable
CREATE TABLE "master_sync_rejects" (
    "reject_id" BIGSERIAL NOT NULL,
    "run_id" BIGINT NOT NULL,
    "entity" TEXT NOT NULL,
    "source_key" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "master_sync_rejects_pkey" PRIMARY KEY ("reject_id")
);

-- CreateIndex
CREATE INDEX "master_sync_rejects_run_id_entity_reason_idx" ON "master_sync_rejects"("run_id", "entity", "reason");
