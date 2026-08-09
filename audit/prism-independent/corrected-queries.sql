-- ============================================================================================
-- PRISM Reconciliation — corrected queries / proposed fixes
-- Independent read, 2026-08-07. PROPOSALS ONLY — nothing here has been applied.
--
-- Every query below was executed read-only to produce the figures in
-- prism-reconciliation-report.md. AutoPlant access was SELECT-only throughout.
-- ============================================================================================


-- ============================================================================================
-- F1 — THE 5.5-HOUR INGEST SHIFT  (the main defect; not a query bug, a CONSTANT bug)
-- ============================================================================================
--
-- The defect is NOT in a SQL query. It is in application code:
--
--   apps/backend/src/ingestion/autoplant/mapping.ts:15
--     export const AUTOPLANT_UTC_OFFSET_MIN = 330;   -- treats source as IST
--   apps/backend/src/ingestion/normalize.ts:32
--     return new Date(asIfUtcMs - sourceUtcOffsetMinutes * 60_000);   -- subtracts 5.5h
--
-- AutoPlant's `latest_gps_datetime` is now stored in UTC, so the correct offset is 0.
-- The one-line fix is  AUTOPLANT_UTC_OFFSET_MIN = 0  — but DO NOT apply it blind: see the
-- verification query below, and re-run it at the moment of the change. If AutoPlant reverts to
-- IST, this flips back, which is exactly why it needs a monitor rather than a constant.

-- ---- F1.1  PROOF the source is UTC (run against AutoPlant; instant, no table access) --------
SELECT @@system_time_zone                             AS system_tz,      -- observed: UTC
       DATE_FORMAT(NOW(),          '%Y-%m-%d %H:%i:%s') AS now_str,
       DATE_FORMAT(UTC_TIMESTAMP(),'%Y-%m-%d %H:%i:%s') AS utc_str,
       TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), NOW())  AS offset_min;    -- observed: 0
-- If offset_min = 0 AND system_tz = 'UTC', the source is UTC and the FSM offset must be 0.

-- ---- F1.2  PROOF the freshest telemetry tracks UTC, not IST ---------------------------------
-- Compare max_gps against real wall clock at run time. Observed 2026-08-07:
--   max_gps = 11:20:52, real IST = 16:51 (= 11:21 UTC)  -> tracks UTC.
SELECT DATE_FORMAT(MAX(latest_gps_datetime), '%Y-%m-%d %H:%i:%s') AS max_gps
FROM   tb_vehiclemaster
WHERE  plant_id IN ('3121','3122');

-- ---- F1.3  ONGOING MONITOR (recommended) ----------------------------------------------------
-- Fleet-wide drift check: AutoPlant's newest ping vs FSM's newest stored ping.
-- Expected after the fix: a small positive lag (minutes). A hard floor at exactly 5.50 means
-- the offset is wrong again. Run this on a schedule — it is the check that was missing.
--   AutoPlant side:
--     SELECT DATE_FORMAT(MAX(latest_gps_datetime),'%Y-%m-%d %H:%i:%s') FROM tb_vehiclemaster;
--   FSM side:
SELECT to_char(MAX(latest_gps_datetime) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS fsm_newest_utc
FROM   device_states;
-- Difference should be minutes, never a clean 5:30.

-- ---- F1.4  BLAST RADIUS — how many devices are falsely inactive right now -------------------
-- Measured 2026-08-07: total_operational 15,696 · inactive_now 2,675 · inactive_fixed 2,241
--                      falsely_inactive 434  (~16% of the inactive queue is fabricated)
SELECT COUNT(*)                                                              AS total_operational,
       COUNT(*) FILTER (WHERE is_inactive AND sla_bucket IS NOT NULL)        AS inactive_now,
       COUNT(*) FILTER (WHERE latest_gps_datetime IS NOT NULL
                          AND (inactivity_hours - 5.5) >= 24)                AS inactive_fixed,
       COUNT(*) FILTER (WHERE is_inactive AND sla_bucket IS NOT NULL
                          AND latest_gps_datetime IS NOT NULL
                          AND (inactivity_hours - 5.5) < 24)                 AS falsely_inactive
FROM   device_states
WHERE  is_departed = false;
-- NOTE: `- 5.5` here is a DIAGNOSTIC to size the impact. It is NOT the fix. The fix is the
-- ingest constant; once corrected, inactivity_hours is right at source and this hack disappears.

-- ---- F1.5  AFTER-FIX VERIFICATION ------------------------------------------------------------
-- After correcting the constant and re-running ingestion, this must return ZERO rows.
SELECT ds.device_id, ds.latest_gps_datetime, ds.inactivity_hours
FROM   device_states ds
WHERE  ds.is_departed = false
  AND  ds.is_inactive = true
  AND  ds.latest_gps_datetime IS NOT NULL
  AND  (ds.inactivity_hours - 5.5) < 24
LIMIT  50;


-- ============================================================================================
-- F2 — NEVER-REPORTED DEVICES COUNTED AS HEALTHY
-- ============================================================================================
--
-- BEFORE  (dashboard.service.ts:38-43, FLEET_COUNT_COLUMNS as shipped)
--   A device with latest_gps_datetime IS NULL has inactivity_hours NULL -> is_inactive false
--   -> it falls into healthyOperational. Never-reported is silently read as healthy.
--
--   COUNT(*) FILTER (WHERE ds.is_departed = false
--     AND NOT (ds.is_inactive = true AND ds.sla_bucket IS NOT NULL))::int AS "healthyOperational"
--
-- AFTER  (proposed — adds a third peer state, mirroring the Excel's NDD)
--   Splits never-reported out of healthy instead of hiding it there. The identity
--   healthy + inactive + neverReported = operational still holds, so every existing
--   sum-check in the dashboard keeps working.
SELECT COUNT(*)                                                                 AS "mirroredDevices",
       COUNT(*) FILTER (WHERE ds.is_departed = false)                           AS "operationalDevices",
       COUNT(*) FILTER (WHERE ds.is_departed = true)                            AS "warehouseDevices",
       COUNT(*) FILTER (WHERE ds.is_departed = false
                          AND ds.is_inactive = true
                          AND ds.sla_bucket IS NOT NULL)                        AS "inactiveOperational",
       -- NEW: the Excel's NDD — never reported at all, distinct from "went quiet".
       COUNT(*) FILTER (WHERE ds.is_departed = false
                          AND ds.latest_gps_datetime IS NULL)                   AS "neverReported",
       -- CHANGED: healthy now requires positive evidence of a ping.
       COUNT(*) FILTER (WHERE ds.is_departed = false
                          AND ds.latest_gps_datetime IS NOT NULL
                          AND NOT (ds.is_inactive = true
                                   AND ds.sla_bucket IS NOT NULL))              AS "healthyOperational"
FROM   device_states ds
WHERE  ds.plant_id IN (18, 19);   -- PRISM / SATNA_PLANT; drop for fleet-wide
-- Measured fleet-wide: 913 devices move out of healthy into neverReported.


-- ============================================================================================
-- F3 — THE `SATNA_PLANT` LABEL SPANS TWO FSM PLANTS
-- ============================================================================================
-- Not a defect: AutoPlant's own master holds these as two plants and FSM mirrors that
-- faithfully. Included so any comparison against this Excel groups correctly.
--
-- Excel "SATNA_PLANT"  ==  AutoPlant plant_id 3121 + 3122
--                      ==  FSM plant_id 18 (LINE 1) + 19 (LINE 2)
SELECT p.plant_id, p.name, p.source_plant_id, COUNT(*) AS devices
FROM   device_states ds
JOIN   plants p ON p.plant_id = ds.plant_id
WHERE  p.source_plant_id IN (3121, 3122)
GROUP  BY p.plant_id, p.name, p.source_plant_id;


-- ============================================================================================
-- REFERENCE — the population reconciliation behind Part 1 of the report
-- ============================================================================================

-- AutoPlant side: 2,819 raw rows for the two Satna plants (Excel holds 2,583 of them).
SELECT COUNT(*)                    AS total,
       COUNT(DISTINCT vehicle_no)  AS distinct_vehicles,   -- 2,819 — no fan-out
       COUNT(DISTINCT device_id)   AS distinct_devices     -- 2,819 — safe grain
FROM   tb_vehiclemaster
WHERE  plant_id IN ('3121','3122');

-- The two confirmed Excel-export exclusions (52 + 156 of the 236; 28 remain unexplained).
SELECT CASE WHEN hierarchy_path <> '1016'      THEN 'other company (1000)'
            WHEN REMARKS = 'NOT ON TIME'       THEN 'REMARKS = NOT ON TIME'
            ELSE                                    'included or unexplained' END AS bucket,
       COUNT(*) AS n
FROM   tb_vehiclemaster
WHERE  plant_id IN ('3121','3122')
GROUP  BY bucket;

-- FSM side: why 1,034 Excel devices are absent — the master-sync insert gate
-- (master-mapping.ts:144, OPERATIONAL_DEPLOYMENT_STATUSES). Intended behaviour.
SELECT v.status, COUNT(*) AS n
FROM   vehicles v
WHERE  v.plant_id IN (18, 19)
GROUP  BY v.status;
