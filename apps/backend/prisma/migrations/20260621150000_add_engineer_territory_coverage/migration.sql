-- Issue 09, slice 2 — engineer_territory_coverage (Floating-SE Territory, ADR-0006, schema D3).
-- Hierarchical (state/region/district) AND/OR polygon; membership is the union of set dimensions.

CREATE TABLE "engineer_territory_coverage" (
    "id" BIGSERIAL NOT NULL,
    "se_id" UUID NOT NULL,
    "district_id" BIGINT,
    "region_id" BIGINT,
    "state" TEXT,
    "polygon" geometry(MultiPolygon, 4326),
    CONSTRAINT "engineer_territory_coverage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "engineer_territory_coverage_se_id_idx" ON "engineer_territory_coverage"("se_id");
CREATE INDEX "engineer_territory_coverage_polygon_gist" ON "engineer_territory_coverage" USING GIST ("polygon");

ALTER TABLE "engineer_territory_coverage" ADD CONSTRAINT "engineer_territory_coverage_se_id_fkey"
    FOREIGN KEY ("se_id") REFERENCES "engineer_master"("engineer_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "engineer_territory_coverage" ADD CONSTRAINT "engineer_territory_coverage_district_id_fkey"
    FOREIGN KEY ("district_id") REFERENCES "districts"("district_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "engineer_territory_coverage" ADD CONSTRAINT "engineer_territory_coverage_region_id_fkey"
    FOREIGN KEY ("region_id") REFERENCES "regions"("region_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- At least one territory dimension must be set (a row covering nothing is meaningless).
ALTER TABLE "engineer_territory_coverage" ADD CONSTRAINT "engineer_territory_coverage_has_dimension_chk"
    CHECK ("district_id" IS NOT NULL OR "region_id" IS NOT NULL OR "state" IS NOT NULL OR "polygon" IS NOT NULL);
