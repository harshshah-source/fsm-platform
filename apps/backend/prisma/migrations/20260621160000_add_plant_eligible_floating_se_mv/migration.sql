-- Issue 09, slice 4 — plant_eligible_floating_se materialized view (ADR-0006).
--
-- Precomputes the plant → eligible-Floating-SE union: a plant is eligible for a FLOATING SE if it
-- matches ANY of the SE's territory dimensions — hierarchical (district / region / state, via the
-- plant's district rollup) or spatial (`ST_Contains(polygon, plant.location)`). Created WITH NO DATA;
-- the first REFRESH (PlantEligibleFloatingSeService.refresh) populates it. The unique index doubles
-- as the dedupe key and enables REFRESH ... CONCURRENTLY once populated.

CREATE MATERIALIZED VIEW "plant_eligible_floating_se" AS
SELECT DISTINCT p.plant_id, etc.se_id
FROM plants p
LEFT JOIN districts d ON d.district_id = p.district_id
JOIN engineer_territory_coverage etc ON (
       (etc.district_id IS NOT NULL AND etc.district_id = p.district_id)
    OR (etc.region_id   IS NOT NULL AND etc.region_id   = d.region_id)
    OR (etc.state       IS NOT NULL AND etc.state       = d.state)
    OR (etc.polygon     IS NOT NULL AND p.location IS NOT NULL AND ST_Contains(etc.polygon, p.location))
)
WITH NO DATA;

CREATE UNIQUE INDEX "plant_eligible_floating_se_pk"
  ON "plant_eligible_floating_se" ("plant_id", "se_id");
