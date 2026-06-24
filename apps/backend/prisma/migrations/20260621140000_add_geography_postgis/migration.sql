-- Issue 09, slice 1 — geography + PostGIS foundation for Floating-SE territory (ADR-0006).
--
-- The PostGIS extension itself is a per-database superuser bootstrap (CONTEXT.md: "the managed
-- Postgres provider must enable the PostGIS extension"), created out-of-band alongside the role/db,
-- because the application role is not a superuser and `postgis` is not a trusted extension. This
-- migration assumes the `geometry` type is already available in the database.

-- regions (admin geography, region level)
CREATE TABLE "regions" (
    "region_id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    CONSTRAINT "regions_pkey" PRIMARY KEY ("region_id")
);
CREATE UNIQUE INDEX "regions_name_key" ON "regions"("name");

-- districts (admin geography, district level; ~700 seeded later)
CREATE TABLE "districts" (
    "district_id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "region_id" BIGINT,
    CONSTRAINT "districts_pkey" PRIMARY KEY ("district_id")
);
CREATE UNIQUE INDEX "districts_name_state_key" ON "districts"("name", "state");
CREATE INDEX "districts_region_id_idx" ON "districts"("region_id");
ALTER TABLE "districts" ADD CONSTRAINT "districts_region_id_fkey"
    FOREIGN KEY ("region_id") REFERENCES "regions"("region_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- plants: PostGIS point + GIST index for ST_Contains membership, and the district_id FK
-- (the column already exists from 20260618104756_add_plants).
ALTER TABLE "plants" ADD COLUMN "location" geometry(Point, 4326);
CREATE INDEX "plants_location_gist" ON "plants" USING GIST ("location");
ALTER TABLE "plants" ADD CONSTRAINT "plants_district_id_fkey"
    FOREIGN KEY ("district_id") REFERENCES "districts"("district_id") ON DELETE RESTRICT ON UPDATE CASCADE;
