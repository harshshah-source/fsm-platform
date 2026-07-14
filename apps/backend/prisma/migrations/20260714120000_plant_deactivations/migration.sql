-- Issue 119 — FSM-owned plant deactivation (side table, anti-drift like plant_zone_overrides).
-- A row is the ACTIVE deactivation while reactivated_at IS NULL; reactivation stamps reactivated_at/by
-- and keeps the row as history. The partial-unique index enforces at most one ACTIVE deactivation per
-- plant while permitting repeated deactivate/reactivate cycles (raw SQL — partial uniques are not
-- expressible in the Prisma schema, same posture as recommendations_one_suggested_per_ticket).

CREATE TABLE "plant_deactivations" (
  "id"                  BIGSERIAL      NOT NULL,
  "plant_id"            BIGINT         NOT NULL,
  "reason"              TEXT           NOT NULL,
  "deactivated_by"      UUID,
  "deactivated_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reactivation_reason" TEXT,
  "reactivated_by"      UUID,
  "reactivated_at"      TIMESTAMPTZ(6),
  "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "plant_deactivations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "plant_deactivations_plant_id_idx" ON "plant_deactivations"("plant_id");

-- At most one ACTIVE deactivation per plant; historical (reactivated) rows are unconstrained.
CREATE UNIQUE INDEX "plant_deactivations_one_active_per_plant"
  ON "plant_deactivations" ("plant_id") WHERE "reactivated_at" IS NULL;

ALTER TABLE "plant_deactivations"
  ADD CONSTRAINT "plant_deactivations_plant_id_fkey"
  FOREIGN KEY ("plant_id") REFERENCES "plants"("plant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
