-- Issue 11, slice 1 — dispatch / Day-Plan schema (LLD §3.6, schema D-sched).
-- work_schedules <- plant_batch_assignments <- batch_assignment_tickets.
-- No approval gate (ADR-0007/0019 superseded): no DRAFT/PENDING_REVIEW/APPROVED states;
-- batches dispatch directly as AUTO_ASSIGNED, ZM overrides post-hoc (OVERRIDDEN).

CREATE TYPE "work_schedule_status" AS ENUM ('ACTIVE', 'OVERRIDDEN', 'COMPLETED', 'PARTIAL');
CREATE TYPE "schedule_source" AS ENUM ('SYSTEM_GENERATED', 'ZM_MANUAL');
CREATE TYPE "batch_status" AS ENUM ('AUTO_ASSIGNED', 'OVERRIDDEN', 'COMPLETED', 'PARTIAL');

CREATE TABLE "work_schedules" (
    "schedule_id" BIGSERIAL NOT NULL,
    "se_id" UUID NOT NULL,
    "zone_id" BIGINT NOT NULL,
    "date_from" DATE NOT NULL,
    "date_to" DATE NOT NULL,
    "status" "work_schedule_status" NOT NULL DEFAULT 'ACTIVE',
    "source" "schedule_source" NOT NULL DEFAULT 'SYSTEM_GENERATED',
    "dispatched_at" TIMESTAMPTZ(6),
    "last_overridden_by" UUID,
    "last_overridden_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "work_schedules_pkey" PRIMARY KEY ("schedule_id")
);

CREATE INDEX "work_schedules_se_id_date_from_idx" ON "work_schedules"("se_id", "date_from");
CREATE INDEX "work_schedules_zone_id_status_idx" ON "work_schedules"("zone_id", "status");

CREATE TABLE "plant_batch_assignments" (
    "batch_id" BIGSERIAL NOT NULL,
    "schedule_id" BIGINT NOT NULL,
    "plant_id" BIGINT NOT NULL,
    "se_id" UUID NOT NULL,
    "status" "batch_status" NOT NULL DEFAULT 'AUTO_ASSIGNED',
    "stop_sequence" INTEGER NOT NULL,
    "override_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "plant_batch_assignments_pkey" PRIMARY KEY ("batch_id")
);

CREATE INDEX "plant_batch_assignments_schedule_id_idx" ON "plant_batch_assignments"("schedule_id");
CREATE INDEX "plant_batch_assignments_plant_id_idx" ON "plant_batch_assignments"("plant_id");
CREATE INDEX "plant_batch_assignments_se_id_idx" ON "plant_batch_assignments"("se_id");

CREATE TABLE "batch_assignment_tickets" (
    "id" BIGSERIAL NOT NULL,
    "batch_id" BIGINT NOT NULL,
    "ticket_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "deferred_to_date" DATE,
    "removed_at" TIMESTAMPTZ(6),
    "removed_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "batch_assignment_tickets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "batch_assignment_tickets_batch_id_idx" ON "batch_assignment_tickets"("batch_id");

ALTER TABLE "work_schedules" ADD CONSTRAINT "work_schedules_se_id_fkey"
    FOREIGN KEY ("se_id") REFERENCES "engineer_master"("engineer_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "work_schedules" ADD CONSTRAINT "work_schedules_zone_id_fkey"
    FOREIGN KEY ("zone_id") REFERENCES "zones"("zone_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "plant_batch_assignments" ADD CONSTRAINT "plant_batch_assignments_schedule_id_fkey"
    FOREIGN KEY ("schedule_id") REFERENCES "work_schedules"("schedule_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "plant_batch_assignments" ADD CONSTRAINT "plant_batch_assignments_plant_id_fkey"
    FOREIGN KEY ("plant_id") REFERENCES "plants"("plant_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "plant_batch_assignments" ADD CONSTRAINT "plant_batch_assignments_se_id_fkey"
    FOREIGN KEY ("se_id") REFERENCES "engineer_master"("engineer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "batch_assignment_tickets" ADD CONSTRAINT "batch_assignment_tickets_batch_id_fkey"
    FOREIGN KEY ("batch_id") REFERENCES "plant_batch_assignments"("batch_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "batch_assignment_tickets" ADD CONSTRAINT "batch_assignment_tickets_ticket_id_fkey"
    FOREIGN KEY ("ticket_id") REFERENCES "tickets"("ticket_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One active batch per ticket (partial unique; not expressible in Prisma — same posture as se_coverage).
CREATE UNIQUE INDEX "batch_assignment_tickets_one_active_per_ticket"
    ON "batch_assignment_tickets"("ticket_id") WHERE "removed_at" IS NULL;
