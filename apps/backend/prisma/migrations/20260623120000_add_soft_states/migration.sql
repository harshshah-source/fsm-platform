-- Issue 15, slice 1 — soft_states (schema D7). Temporary SE field-progress signals
-- (VIEWED / ON_SITE / TROUBLESHOOT_STARTED); not a lifecycle state and not a lock. Primary input to
-- the derived SE Activity Status (ADR-0023). Partial unique + CHECKs are raw SQL (not Prisma-expressible).

CREATE TYPE "soft_state_type" AS ENUM ('VIEWED', 'ON_SITE', 'TROUBLESHOOT_STARTED');
CREATE TYPE "onsite_source" AS ENUM ('AUTO_GEOFENCE', 'MANUAL');

CREATE TABLE "soft_states" (
    "soft_state_id" BIGSERIAL NOT NULL,
    "ticket_id" UUID NOT NULL,
    "se_id" UUID NOT NULL,
    "type" "soft_state_type" NOT NULL,
    "onsite_source" "onsite_source",
    "set_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "timeout_at" TIMESTAMPTZ(6),
    "resolved_at" TIMESTAMPTZ(6),
    "resolved_by" TEXT,
    "resolution_reason" TEXT,
    CONSTRAINT "soft_states_pkey" PRIMARY KEY ("soft_state_id")
);

-- SE's soft states (Prisma @@index([seId, resolvedAt])).
CREATE INDEX "soft_states_se_id_resolved_at_idx" ON "soft_states"("se_id", "resolved_at");

-- I24 — one active soft state of each type per SE per ticket (a double-tap/retry cannot duplicate).
CREATE UNIQUE INDEX "ux_ss_active" ON "soft_states"("ticket_id", "se_id", "type") WHERE "resolved_at" IS NULL;

-- Active soft states on a ticket (override-conflict checks, Activity Status).
CREATE INDEX "ix_ss_active_ticket" ON "soft_states"("ticket_id") WHERE "resolved_at" IS NULL;
-- SoftStateTimeoutWorker sweep — VIEWED rows due to clear.
CREATE INDEX "ix_ss_viewed_timeout" ON "soft_states"("timeout_at") WHERE "resolved_at" IS NULL AND "type" = 'VIEWED';
-- Stale-work warning sweep — long-running active states.
CREATE INDEX "ix_ss_stale" ON "soft_states"("set_at") WHERE "resolved_at" IS NULL;

-- VIEWED expires (timeout_at set); ON_SITE / TROUBLESHOOT_STARTED never time-expire (timeout_at null).
ALTER TABLE "soft_states" ADD CONSTRAINT "soft_states_viewed_timeout_present"
    CHECK ("type" <> 'VIEWED' OR "timeout_at" IS NOT NULL);
ALTER TABLE "soft_states" ADD CONSTRAINT "soft_states_nonviewed_no_timeout"
    CHECK ("type" = 'VIEWED' OR "timeout_at" IS NULL);
-- onsite_source only meaningful for ON_SITE.
ALTER TABLE "soft_states" ADD CONSTRAINT "soft_states_onsite_source_scope"
    CHECK ("onsite_source" IS NULL OR "type" = 'ON_SITE');

ALTER TABLE "soft_states" ADD CONSTRAINT "soft_states_ticket_id_fkey"
    FOREIGN KEY ("ticket_id") REFERENCES "tickets"("ticket_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "soft_states" ADD CONSTRAINT "soft_states_se_id_fkey"
    FOREIGN KEY ("se_id") REFERENCES "engineer_master"("engineer_id") ON DELETE RESTRICT ON UPDATE CASCADE;
