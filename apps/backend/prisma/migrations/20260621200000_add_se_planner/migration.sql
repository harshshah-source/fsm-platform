-- Issue 14a, slice 1 — se_planner (LLD §3.6). ZM-authored plant-visit intents; the Morning Batch
-- reads them as a soft bias (ADR-0022). One intent per (se, plant, date).

CREATE TABLE "se_planner" (
    "id" BIGSERIAL NOT NULL,
    "se_id" UUID NOT NULL,
    "plant_id" BIGINT NOT NULL,
    "planned_date" DATE NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "se_planner_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "se_planner_se_id_plant_id_planned_date_key" ON "se_planner"("se_id", "plant_id", "planned_date");
CREATE INDEX "se_planner_planned_date_idx" ON "se_planner"("planned_date");

ALTER TABLE "se_planner" ADD CONSTRAINT "se_planner_se_id_fkey"
    FOREIGN KEY ("se_id") REFERENCES "engineer_master"("engineer_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "se_planner" ADD CONSTRAINT "se_planner_plant_id_fkey"
    FOREIGN KEY ("plant_id") REFERENCES "plants"("plant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
