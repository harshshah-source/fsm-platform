-- Phase 4 — master-sync foundation (additive / non-breaking).
-- Two deferred pieces the master synchroniser depends on:
--   1. vehicles.transporter_id -> transporters FK  (deferred out of Phase 2a: the transporters table
--      was created empty, so any pre-existing non-null transporter_id would dangle). We null the
--      dangling values first, then add the FK. Prisma-default referential actions for an OPTIONAL
--      relation: ON DELETE SET NULL, ON UPDATE CASCADE (keep the schema and DB in lockstep).
--   2. master_sync_runs single-in-flight backstop — the partial-unique index mirroring
--      snapshot_runs_one_in_flight, so overlapping scheduler ticks can never open two RUNNING runs.
--      (The advisory lock in MasterSyncRunService.startRun is txn-scoped; this index is the durable
--      cross-connection guard, exactly as for snapshot_runs.)
-- NO zone_id nullability change, NO state->zone map, NO scoping values — those stay business-gated
-- (Risk R6/R14). This migration only lands the mechanism.

-- ── 1. vehicles.transporter_id -> transporters FK ─────────────────────────────────────────────────
UPDATE "vehicles" v
   SET "transporter_id" = NULL
 WHERE v."transporter_id" IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM "transporters" t WHERE t."transporter_id" = v."transporter_id"
   );

ALTER TABLE "vehicles"
  ADD CONSTRAINT "vehicles_transporter_id_fkey"
  FOREIGN KEY ("transporter_id") REFERENCES "transporters"("transporter_id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 2. master_sync_runs single-in-flight guard (mirrors snapshot_runs_one_in_flight) ──────────────
CREATE UNIQUE INDEX "master_sync_runs_one_in_flight"
  ON "master_sync_runs" ("status") WHERE "status" = 'RUNNING';
