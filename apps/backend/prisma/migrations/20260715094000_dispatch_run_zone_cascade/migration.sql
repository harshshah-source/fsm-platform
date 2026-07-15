-- A dispatch_run_zones row is meaningless without its zone: every run writes one row per active
-- zone, so a RESTRICT here made ANY zone deletion fail once a single run had ever executed
-- (zones are never deleted in production, but e2e suites create + delete zones constantly, and a
-- run from one suite references every other suite's zones). CASCADE keeps the ledger row exactly
-- as long as the zone it describes exists.

ALTER TABLE "dispatch_run_zones"
  DROP CONSTRAINT "dispatch_run_zones_zone_id_fkey",
  ADD CONSTRAINT "dispatch_run_zones_zone_id_fkey"
    FOREIGN KEY ("zone_id") REFERENCES "zones"("zone_id") ON DELETE CASCADE ON UPDATE CASCADE;
