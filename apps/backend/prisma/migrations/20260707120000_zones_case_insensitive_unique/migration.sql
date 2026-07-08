-- Zones are an FSM-owned authority partition (one ZM per zone); names that differ only by case are
-- the SAME zone. The schema's unique on zones.name is case-SENSITIVE, which let "West"/"WEST" (and
-- North/NORTH, East/EAST, South/SOUTH) coexist after Title-case org-seed and UPPERCASE dev fixtures
-- both ran — splitting one operational zone in two and making every case-insensitive zone lookup
-- (`findFirst mode: 'insensitive'`, no orderBy) nondeterministic. Production databases seeded only
-- by org-seed have no duplicates, so steps 1–2 are a no-op there; the index in step 3 is the guard.

-- 1) Merge case-duplicate zones: per lower(name) group, keep the lowest zone_id and repoint every
--    true FK reference (discovered dynamically, so a future zones FK can't be silently missed) from
--    each loser to the keeper, then delete the loser. Historical dims WITHOUT an FK (report rollups,
--    audit_log.acting_zone, zone_health_snapshots) intentionally keep their original ids — they are
--    frozen history, not live references.
DO $$
DECLARE
  merge_row RECORD;
  fk RECORD;
BEGIN
  FOR merge_row IN
    SELECT z.zone_id AS loser_id, k.keeper_id
    FROM zones z
    JOIN (
      SELECT lower(name) AS lname, min(zone_id) AS keeper_id
      FROM zones
      GROUP BY lower(name)
      HAVING count(*) > 1
    ) k ON lower(z.name) = k.lname
    WHERE z.zone_id <> k.keeper_id
    ORDER BY z.zone_id
  LOOP
    -- zone_warehouse_stock is UNIQUE(zone_id, component_id): drop loser rows the keeper already
    -- covers so the generic repoint below cannot collide.
    DELETE FROM zone_warehouse_stock s
    WHERE s.zone_id = merge_row.loser_id
      AND EXISTS (
        SELECT 1 FROM zone_warehouse_stock t
        WHERE t.zone_id = merge_row.keeper_id AND t.component_id = s.component_id
      );

    FOR fk IN
      SELECT kcu.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = current_schema()
        AND ccu.table_name = 'zones'
        AND ccu.column_name = 'zone_id'
    LOOP
      EXECUTE format(
        'UPDATE %I SET %I = $1 WHERE %I = $2',
        fk.table_name, fk.column_name, fk.column_name
      ) USING merge_row.keeper_id, merge_row.loser_id;
    END LOOP;

    DELETE FROM zones WHERE zone_id = merge_row.loser_id;
  END LOOP;
END $$;

-- 2) Canonical casing (org-seed spelling): Title Case for the four compass zones, UNZONED verbatim.
UPDATE zones SET name = initcap(name)
  WHERE lower(name) IN ('north', 'south', 'east', 'west') AND name <> initcap(name);
UPDATE zones SET name = 'UNZONED'
  WHERE lower(name) = 'unzoned' AND name <> 'UNZONED';

-- 3) The guard: zone names are unique case-insensitively. (Raw expression index — not representable
--    in schema.prisma; the exact-match @unique on name stays alongside it.)
CREATE UNIQUE INDEX "zones_name_ci_key" ON "zones" (lower("name"));
