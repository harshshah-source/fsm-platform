-- CreateEnum
CREATE TYPE "deal_type" AS ENUM ('RECURRING', 'ONE_TIME');

-- CreateEnum
CREATE TYPE "sla_bucket" AS ENUM ('WARNING', 'EARLY_RISK', 'RISK', 'CRITICAL', 'HIGH_CRITICAL', 'SEVERE', 'VERY_SEVERE', 'LONG_PENDING');

-- CreateEnum
CREATE TYPE "failure_cycle_state" AS ENUM ('OPEN', 'WAITING_COMPONENT', 'SUBMITTED', 'VERIFIED', 'FAILED', 'REPEAT', 'ESCALATED');

-- CreateEnum
CREATE TYPE "sla_pause_reason" AS ENUM ('WAITING_COMPONENT', 'VEHICLE_UNAVAILABLE');

-- CreateEnum
CREATE TYPE "work_type" AS ENUM ('TROUBLESHOOT', 'INSTALL', 'RECOVERY');

-- CreateEnum
CREATE TYPE "ticket_status" AS ENUM ('OPEN', 'SUBMITTED', 'VERIFICATION_PENDING', 'CLOSED', 'CLOSED_AUTO_RECOVERY', 'FAILED_VERIFICATION', 'ESCALATED', 'CLOSED_NON_OPERATIONAL', 'REQUESTED', 'SCHEDULED', 'ON_SITE', 'FITTED', 'ACTIVATED', 'FAILED_ACTIVATION', 'COLLECTED', 'RECEIVED_AT_WAREHOUSE', 'FAILED_RECOVERY');

-- CreateEnum
CREATE TYPE "assignment_state" AS ENUM ('UNASSIGNED', 'FORMALLY_ASSIGNED');

-- CreateEnum
CREATE TYPE "nonop_state" AS ENUM ('REQUESTED', 'AWAITING_CUSTOMER_CONFIRMATION', 'AWAITING_ZM_CONFIRMATION', 'CONFIRMED', 'ACTIVE', 'EXPIRED', 'UNMARKED');

-- CreateTable
CREATE TABLE "devices" (
    "device_id" BIGINT NOT NULL,
    "current_vehicle_id" BIGINT,
    "deal_type" "deal_type",
    "device_type" TEXT,
    "sim_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("device_id")
);

-- CreateTable
CREATE TABLE "vehicles" (
    "vehicle_id" BIGSERIAL NOT NULL,
    "vehicle_no" TEXT NOT NULL,
    "plant_id" BIGINT NOT NULL,
    "transporter_id" BIGINT,
    "company_id" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("vehicle_id")
);

-- CreateTable
CREATE TABLE "device_states" (
    "device_id" BIGINT NOT NULL,
    "latest_gps_datetime" TIMESTAMPTZ(6),
    "is_inactive" BOOLEAN NOT NULL DEFAULT false,
    "inactivity_hours" DECIMAL(12,4),
    "sla_bucket" "sla_bucket",
    "eligible_for_uptime" BOOLEAN NOT NULL DEFAULT false,
    "has_open_failure_cycle" BOOLEAN NOT NULL DEFAULT false,
    "vehicle_id" BIGINT,
    "plant_id" BIGINT,
    "company_id" BIGINT,
    "transporter_id" BIGINT,
    "computed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "device_states_pkey" PRIMARY KEY ("device_id")
);

-- CreateTable
CREATE TABLE "failure_cycles" (
    "cycle_id" UUID NOT NULL,
    "device_id" BIGINT NOT NULL,
    "state" "failure_cycle_state" NOT NULL DEFAULT 'OPEN',
    "opened_at" TIMESTAMPTZ(6) NOT NULL,
    "closed_at" TIMESTAMPTZ(6),
    "previous_failure_cycle_id" UUID,
    "repeat_failure" BOOLEAN NOT NULL DEFAULT false,
    "sla_paused" BOOLEAN NOT NULL DEFAULT false,
    "sla_pause_reason" "sla_pause_reason",
    "sla_paused_at" TIMESTAMPTZ(6),
    "sla_pause_source" TEXT,
    "sla_accumulated_pause_seconds" BIGINT NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "failure_cycles_pkey" PRIMARY KEY ("cycle_id")
);

-- CreateTable
CREATE TABLE "tickets" (
    "ticket_id" UUID NOT NULL,
    "work_type" "work_type" NOT NULL,
    "status" "ticket_status" NOT NULL,
    "failure_cycle_id" UUID,
    "device_id" BIGINT NOT NULL,
    "vehicle_id" BIGINT,
    "plant_id" BIGINT NOT NULL,
    "company_id" BIGINT NOT NULL,
    "company_tier" "company_tier" NOT NULL,
    "assignment_state" "assignment_state" NOT NULL DEFAULT 'UNASSIGNED',
    "repeat_failure" BOOLEAN NOT NULL DEFAULT false,
    "last_state_changed_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("ticket_id")
);

-- CreateTable
CREATE TABLE "pgi_history" (
    "id" BIGSERIAL NOT NULL,
    "device_id" BIGINT NOT NULL,
    "pgi_date" DATE NOT NULL,
    "order_ref" TEXT,

    CONSTRAINT "pgi_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "non_operational_markings" (
    "marking_id" UUID NOT NULL,
    "device_id" BIGINT NOT NULL,
    "state" "nonop_state" NOT NULL DEFAULT 'REQUESTED',
    "effective_from" TIMESTAMPTZ(6),
    "effective_to" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "non_operational_markings_pkey" PRIMARY KEY ("marking_id")
);

-- CreateIndex
CREATE INDEX "devices_current_vehicle_id_idx" ON "devices"("current_vehicle_id");

-- CreateIndex
CREATE INDEX "devices_deal_type_idx" ON "devices"("deal_type");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_vehicle_no_key" ON "vehicles"("vehicle_no");

-- CreateIndex
CREATE INDEX "vehicles_plant_id_idx" ON "vehicles"("plant_id");

-- CreateIndex
CREATE INDEX "vehicles_company_id_idx" ON "vehicles"("company_id");

-- CreateIndex
CREATE INDEX "vehicles_transporter_id_idx" ON "vehicles"("transporter_id");

-- CreateIndex
CREATE INDEX "device_states_is_inactive_sla_bucket_idx" ON "device_states"("is_inactive", "sla_bucket");

-- CreateIndex
CREATE INDEX "device_states_plant_id_idx" ON "device_states"("plant_id");

-- CreateIndex
CREATE INDEX "device_states_company_id_idx" ON "device_states"("company_id");

-- CreateIndex
CREATE INDEX "device_states_eligible_for_uptime_idx" ON "device_states"("eligible_for_uptime");

-- CreateIndex
CREATE INDEX "failure_cycles_state_idx" ON "failure_cycles"("state");

-- CreateIndex
CREATE INDEX "failure_cycles_device_id_opened_at_idx" ON "failure_cycles"("device_id", "opened_at" DESC);

-- CreateIndex
CREATE INDEX "failure_cycles_previous_failure_cycle_id_idx" ON "failure_cycles"("previous_failure_cycle_id");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_failure_cycle_id_key" ON "tickets"("failure_cycle_id");

-- CreateIndex
CREATE INDEX "tickets_status_plant_id_idx" ON "tickets"("status", "plant_id");

-- CreateIndex
CREATE INDEX "tickets_work_type_status_idx" ON "tickets"("work_type", "status");

-- CreateIndex
CREATE INDEX "tickets_company_id_idx" ON "tickets"("company_id");

-- CreateIndex
CREATE INDEX "pgi_history_device_id_pgi_date_idx" ON "pgi_history"("device_id", "pgi_date" DESC);

-- CreateIndex
CREATE INDEX "non_operational_markings_device_id_state_idx" ON "non_operational_markings"("device_id", "state");

-- CreateIndex
CREATE INDEX "non_operational_markings_state_effective_to_idx" ON "non_operational_markings"("state", "effective_to");

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_current_vehicle_id_fkey" FOREIGN KEY ("current_vehicle_id") REFERENCES "vehicles"("vehicle_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_plant_id_fkey" FOREIGN KEY ("plant_id") REFERENCES "plants"("plant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_master"("company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_states" ADD CONSTRAINT "device_states_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("device_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "failure_cycles" ADD CONSTRAINT "failure_cycles_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("device_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "failure_cycles" ADD CONSTRAINT "failure_cycles_previous_failure_cycle_id_fkey" FOREIGN KEY ("previous_failure_cycle_id") REFERENCES "failure_cycles"("cycle_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_failure_cycle_id_fkey" FOREIGN KEY ("failure_cycle_id") REFERENCES "failure_cycles"("cycle_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("device_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("vehicle_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_plant_id_fkey" FOREIGN KEY ("plant_id") REFERENCES "plants"("plant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_master"("company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pgi_history" ADD CONSTRAINT "pgi_history_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("device_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "non_operational_markings" ADD CONSTRAINT "non_operational_markings_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("device_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Raw-SQL invariants Prisma cannot express (same pattern as se_coverage CHECK / snapshot
--     single-in-flight partial-unique). These are the structural guarantees Issue 05 rests on. ───

-- Invariant I1 — one active Failure Cycle per device. Partial UNIQUE over the active states only;
-- VERIFIED/FAILED/REPEAT/ESCALATED cycles are historical and do not block a new episode.
CREATE UNIQUE INDEX "failure_cycles_one_active_per_device"
  ON "failure_cycles" ("device_id")
  WHERE "state" IN ('OPEN', 'WAITING_COMPONENT', 'SUBMITTED');

-- Invariant I13 — one active Non-Operational marking per device (CONFIRMED or ACTIVE).
CREATE UNIQUE INDEX "non_operational_markings_one_active_per_device"
  ON "non_operational_markings" ("device_id")
  WHERE "state" IN ('CONFIRMED', 'ACTIVE');

-- device_states: inactivity age is never negative (clock skew is clamped to 0 upstream).
ALTER TABLE "device_states"
  ADD CONSTRAINT "device_states_inactivity_hours_nonneg" CHECK ("inactivity_hours" >= 0);

-- tickets: a TROUBLESHOOT ticket must link a Failure Cycle (companion to the I2 UNIQUE).
ALTER TABLE "tickets"
  ADD CONSTRAINT "tickets_troubleshoot_requires_cycle"
  CHECK ("work_type" <> 'TROUBLESHOOT' OR "failure_cycle_id" IS NOT NULL);

-- failure_cycles: valid close window, and the pause flag/reason stay coupled (schema D6 CHECKs).
ALTER TABLE "failure_cycles"
  ADD CONSTRAINT "failure_cycles_valid_close" CHECK ("closed_at" IS NULL OR "closed_at" >= "opened_at");
ALTER TABLE "failure_cycles"
  ADD CONSTRAINT "failure_cycles_pause_coupling" CHECK ("sla_paused" = ("sla_pause_reason" IS NOT NULL));
