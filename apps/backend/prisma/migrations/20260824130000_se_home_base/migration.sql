-- #267 — admin-managed SE home/base for the recommender's `distance` score component (#258 Q6).
--
-- Plain floats, not PostGIS geometry: unlike `plants.location` these need no spatial index, only a
-- haversine read against the recommender's per-zone-run PostGIS prefetch. NULLABLE — an SE without a
-- home base scores `distance` as NOT_AVAILABLE (never a fabricated 0-distance advantage, never a
-- silent default to (0,0), which would be a real point in the Gulf of Guinea).
ALTER TABLE "engineer_master"
  ADD COLUMN "home_lat" DOUBLE PRECISION,
  ADD COLUMN "home_lng" DOUBLE PRECISION;
