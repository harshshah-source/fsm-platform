-- CreateTable
CREATE TABLE "zones" (
    "zone_id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "zonal_manager_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "zones_pkey" PRIMARY KEY ("zone_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "zones_name_key" ON "zones"("name");

-- CreateIndex
CREATE INDEX "zones_zonal_manager_user_id_idx" ON "zones"("zonal_manager_user_id");
