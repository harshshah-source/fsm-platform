-- CreateTable
CREATE TABLE "plants" (
    "plant_id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "zone_id" BIGINT NOT NULL,
    "district_id" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "plants_pkey" PRIMARY KEY ("plant_id")
);

-- CreateIndex
CREATE INDEX "plants_zone_id_idx" ON "plants"("zone_id");

-- AddForeignKey
ALTER TABLE "plants" ADD CONSTRAINT "plants_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "zones"("zone_id") ON DELETE RESTRICT ON UPDATE CASCADE;
