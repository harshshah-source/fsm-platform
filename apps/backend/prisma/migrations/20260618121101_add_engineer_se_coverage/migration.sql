-- CreateEnum
CREATE TYPE "coverage_type" AS ENUM ('DEDICATED', 'MULTI_PLANT', 'FLOATING');

-- CreateTable
CREATE TABLE "engineer_master" (
    "engineer_id" UUID NOT NULL,
    "coverage_type" "coverage_type" NOT NULL,
    "zone_id" BIGINT NOT NULL,
    "daily_capacity" INTEGER NOT NULL,
    "shift_start" TIME(6),
    "shift_end" TIME(6),
    "preferred_notification_channel" TEXT,
    "last_activity_at" TIMESTAMPTZ(6),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "engineer_master_pkey" PRIMARY KEY ("engineer_id")
);

-- CreateTable
CREATE TABLE "se_coverage" (
    "id" BIGSERIAL NOT NULL,
    "se_id" UUID NOT NULL,
    "plant_id" BIGINT NOT NULL,
    "coverage_type" "coverage_type" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "se_coverage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "engineer_master_zone_id_idx" ON "engineer_master"("zone_id");

-- CreateIndex
CREATE INDEX "engineer_master_last_activity_at_idx" ON "engineer_master"("last_activity_at");

-- CreateIndex
CREATE INDEX "se_coverage_plant_id_idx" ON "se_coverage"("plant_id");

-- CreateIndex
CREATE UNIQUE INDEX "se_coverage_se_id_plant_id_key" ON "se_coverage"("se_id", "plant_id");

-- AddForeignKey
ALTER TABLE "engineer_master" ADD CONSTRAINT "engineer_master_engineer_id_fkey" FOREIGN KEY ("engineer_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engineer_master" ADD CONSTRAINT "engineer_master_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "zones"("zone_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "se_coverage" ADD CONSTRAINT "se_coverage_se_id_fkey" FOREIGN KEY ("se_id") REFERENCES "engineer_master"("engineer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "se_coverage" ADD CONSTRAINT "se_coverage_plant_id_fkey" FOREIGN KEY ("plant_id") REFERENCES "plants"("plant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Schema D3 constraints Prisma cannot express in the model:
-- FLOATING SEs use the territory polygon table (Issue 09), never se_coverage.
ALTER TABLE "se_coverage" ADD CONSTRAINT "se_coverage_not_floating_chk" CHECK ("coverage_type" <> 'FLOATING');
-- A DEDICATED SE holds exactly one coverage row.
CREATE UNIQUE INDEX "se_coverage_dedicated_se_key" ON "se_coverage"("se_id") WHERE "coverage_type" = 'DEDICATED';
