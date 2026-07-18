-- Issue 128 — FSM-owned device deployment lifecycle (side table, same posture as plant_deactivations).
--
-- A row is the ACTIVE departure while restored_at IS NULL; re-deployment stamps restored_at/by and keeps
-- the row as history (never deleted). The partial-unique index enforces at most one ACTIVE departure per
-- device while permitting repeated depart/restore cycles (raw SQL — partial uniques are not expressible
-- in the Prisma schema, same posture as plant_deactivations_one_active_per_plant).
--
-- `observed_status` is the VERBATIM AutoPlant status that caused the departure (UNDEPLOYED / MAINTENANCE /
-- an unknown value like 'DEPLOYED/UNDEPLOYED'), or the sentinel MISSING_FROM_SOURCE when the device
-- vanished from the source read entirely. `reason` distinguishes the two detection paths: SOURCE_STATUS
-- (observed, trustworthy) vs ABSENT_FROM_READ (inferred — guard-railed in the sync).

-- A departure-driven ticket close is neither an SE workflow outcome nor an Operations-Head override:
-- the SYSTEM closed it because the device left the fleet. Issue 119 reuses OPERATIONS_HEAD_OVERRIDE_CLOSE
-- because a human OH really does trigger a plant deactivation; reusing it here would misattribute a
-- sync-detected close to a person in every report that groups by closure_type.
ALTER TYPE "closure_type" ADD VALUE IF NOT EXISTS 'DEVICE_UNDEPLOYED_CLOSE';

CREATE TABLE "device_departures" (
  "id"                      BIGSERIAL      NOT NULL,
  "device_id"               TEXT           NOT NULL,
  "observed_status"         TEXT           NOT NULL,
  "reason"                  TEXT           NOT NULL,
  "departed_at"             TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "detected_by_run_id"      BIGINT,
  "cancelled_tickets_count" INTEGER        NOT NULL DEFAULT 0,
  "restored_status"         TEXT,
  "restored_at"             TIMESTAMPTZ(6),
  "restored_by_run_id"      BIGINT,
  "created_at"              TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"              TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "device_departures_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "device_departures_device_id_idx" ON "device_departures"("device_id");
CREATE INDEX "device_departures_detected_by_run_id_idx" ON "device_departures"("detected_by_run_id");

-- At most one ACTIVE departure per device; historical (restored) rows are unconstrained.
CREATE UNIQUE INDEX "device_departures_one_active_per_device"
  ON "device_departures" ("device_id") WHERE "restored_at" IS NULL;

ALTER TABLE "device_departures"
  ADD CONSTRAINT "device_departures_device_id_fkey"
  FOREIGN KEY ("device_id") REFERENCES "devices"("device_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Run provenance: every transition is traceable to the master sync that observed it. SET NULL (not
-- RESTRICT) so run retention/pruning can never be blocked by lifecycle history.
ALTER TABLE "device_departures"
  ADD CONSTRAINT "device_departures_detected_by_run_id_fkey"
  FOREIGN KEY ("detected_by_run_id") REFERENCES "master_sync_runs"("run_id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "device_departures"
  ADD CONSTRAINT "device_departures_restored_by_run_id_fkey"
  FOREIGN KEY ("restored_by_run_id") REFERENCES "master_sync_runs"("run_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Denormalised hot-path flag: every downstream read (inactive / SLA / eligibility / dashboards) stays a
-- single predicate instead of a join to the side table. Derived by DeviceStateService.recompute from the
-- side table, exactly as is_inactive is derived from latest_gps_datetime.
ALTER TABLE "device_states" ADD COLUMN "is_departed" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "device_states_is_departed_idx" ON "device_states"("is_departed");
