-- ============================================================================
-- AutoPlant <-> FSM reconciliation: corrected / diagnostic queries
-- 2026-08-07 · companion to reconciliation-report.md
--
-- READ-ONLY. Nothing here writes. Q1-Q4 run against the FSM Postgres mirror;
-- Q5-Q6 against AutoPlant MySQL (read replica if one exists).
--
-- NOTE: these are diagnostic and reference queries. No FSM source file has been
-- modified — per instruction, code changes are proposed, not applied.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Q1  [F1] The drift itself: is_departed vs vehicles.status
--     Repairs: nothing yet — this QUANTIFIES the defect so a fix can be verified.
--     Expected today (Nuvista): 2,438 UNDEPLOYED/operational + 795 DEPLOYED/departed
-- ----------------------------------------------------------------------------
SELECT v.status                       AS source_status,
       ds.is_departed,
       COUNT(*)::int                  AS devices,
       CASE
         WHEN v.status IN ('DEPLOYED','ACTIVE') AND ds.is_departed THEN 'LIVE VEHICLE HIDDEN IN WAREHOUSE'
         WHEN v.status NOT IN ('DEPLOYED','ACTIVE') AND NOT ds.is_departed THEN 'UNDEPLOYED COUNTED OPERATIONAL'
         ELSE 'consistent'
       END                            AS verdict
FROM device_states ds
JOIN vehicles v ON v.vehicle_id = ds.vehicle_id
WHERE ds.company_id = '4'                      -- Nuvista; drop for pan-India
GROUP BY 1, 2
ORDER BY devices DESC;


-- ----------------------------------------------------------------------------
-- Q2  [F1] Operational fleet computed from the SOURCE status rather than the
--     drifted denormalisation. This reproduces the Excel benchmark.
--     MEASURED 2026-08-07 (not estimated):
--       Excel ground truth (Deployed, shared)  7,641
--       FSM as shipped (is_departed=false)     9,437   +1,796  (+23.5%)
--       This query (vehicles.status)           7,794     +153   (+2.0%)
--     => closes ~91% of the gap. PARTIAL, not a full reconciliation.
--     Residual +153 = 105 FSM-only DEPLOYED devices absent from the Excel
--     + 51 last-observation sync-lag rows. See report F5/F6.
--
--     DIAGNOSTIC ONLY -- do not ship as the dashboard predicate. It bypasses
--     the device_departures ledger, which the #130 ruling pins as lifecycle
--     truth for safety gates. Fix the desync, do not route around it.
--
--     `OPERATIONAL_DEPLOYMENT_STATUSES` = ('DEPLOYED','ACTIVE'), master-mapping.ts:144.
--     Kept as an allow-list so an unrecognised source value reads as non-operational.
-- ----------------------------------------------------------------------------
SELECT COUNT(*)::int AS mirrored,
       COUNT(*) FILTER (WHERE v.status IN ('DEPLOYED','ACTIVE'))::int     AS operational_corrected,
       COUNT(*) FILTER (WHERE v.status NOT IN ('DEPLOYED','ACTIVE'))::int AS warehouse_corrected,
       COUNT(*) FILTER (WHERE ds.is_departed = false)::int                AS operational_as_shipped,
       COUNT(*) FILTER (WHERE v.status IN ('DEPLOYED','ACTIVE'))::int
         - COUNT(*) FILTER (WHERE ds.is_departed = false)::int            AS delta
FROM device_states ds
JOIN vehicles v ON v.vehicle_id = ds.vehicle_id
JOIN plants   p ON p.plant_id   = ds.plant_id
WHERE ds.company_id = '4'
  AND p.plant_id NOT IN (SELECT plant_id FROM plant_deactivations WHERE reactivated_at IS NULL);


-- ----------------------------------------------------------------------------
-- Q3  [F3] NDD as a third state, instead of silently counted healthy.
--     Excel: Active 13,429 / Inactive 11,442 / NDD 343 -- three peers.
--     FSM's healthyOperational currently absorbs never-reported devices because
--     it is defined as NOT(inactive), and a null-GPS device is not inactive.
-- ----------------------------------------------------------------------------
SELECT COUNT(*) FILTER (WHERE ds.is_departed = false
                          AND ds.latest_gps_datetime IS NULL)::int        AS ndd_never_reported,
       COUNT(*) FILTER (WHERE ds.is_departed = false
                          AND ds.latest_gps_datetime IS NOT NULL
                          AND ds.is_inactive AND ds.sla_bucket IS NOT NULL)::int AS inactive_true,
       COUNT(*) FILTER (WHERE ds.is_departed = false
                          AND ds.latest_gps_datetime IS NOT NULL
                          AND NOT (ds.is_inactive AND ds.sla_bucket IS NOT NULL))::int AS healthy_true,
       -- what the dashboard shows today: ndd is folded into healthy
       COUNT(*) FILTER (WHERE ds.is_departed = false
                          AND NOT (ds.is_inactive AND ds.sla_bucket IS NOT NULL))::int AS healthy_as_shipped
FROM device_states ds
JOIN plants p ON p.plant_id = ds.plant_id
WHERE ds.company_id = '4'
  AND p.plant_id NOT IN (SELECT plant_id FROM plant_deactivations WHERE reactivated_at IS NULL);


-- ----------------------------------------------------------------------------
-- Q4  [F2] Telemetry staleness monitor. Median GPS age should track the snapshot
--     cadence; on 2026-08-07 it was ~5.1h behind AutoPlant with the last run
--     only 15 minutes old -- i.e. a stalled/partial ingest, not a missed run.
--     A device whose age is inflated by 5.1h crosses the 24h inactivity
--     threshold ~5h early: 80 devices were false-inactive on this snapshot.
-- ----------------------------------------------------------------------------
SELECT MAX(ds.latest_gps_datetime)                                   AS freshest_gps,
       MAX(ds.computed_at)                                           AS last_recompute,
       EXTRACT(EPOCH FROM (MAX(ds.computed_at) - MAX(ds.latest_gps_datetime)))/3600 AS lag_hours,
       COUNT(*) FILTER (WHERE ds.latest_gps_datetime
                              < MAX(ds.computed_at) OVER () - INTERVAL '24 hours')::int AS would_be_inactive
FROM device_states ds
WHERE ds.company_id = '4';


-- ----------------------------------------------------------------------------
-- Q5  [F4] AutoPlant: the 9 Excel-"Deployed" devices FSM never mirrored.
--     Bounded 9-key lookup. Result 2026-08-07: all 9 are UNDEPLOYED in
--     mst_vehicle -- so FSM's exclusion is correct and the EXCEL disagrees
--     with the source. Re-run to confirm before acting on those rows.
-- ----------------------------------------------------------------------------
SELECT device_id, vehicle_no, plant_id, deployment_status
FROM `ap_masters`.`mst_vehicle`
WHERE device_id IN ('867542081467592','867542081502265','867542081486428',
                    '867542081350921','867542081316898','867542081483599',
                    '862491072520602','867542081358619','867542081500061');


-- ----------------------------------------------------------------------------
-- Q6  [F4/F5] Does the Excel's "Deployment Status" come from mst_vehicle or from
--     tb_vehiclemaster? This settles F4. Aggregate join, no row scan returned.
--     The 2026-07-17 investigation measured these disagreeing ~1.3% of the time;
--     if the Excel tracks the tb_vehiclemaster column, the 9 anomalies vanish.
-- ----------------------------------------------------------------------------
SELECT m.deployment_status                AS mst_status,
       t.vehicle_deployment_status        AS widgets_status,
       COUNT(*)                           AS n
FROM `ap_masters`.`mst_vehicle` m
JOIN `ap_widgets`.`tb_vehiclemaster` t ON t.device_id = m.device_id
WHERE m.plant_id IN ('3093','3532','3528','3097','3604','3461','3096','3128','4170','4167','3605',
                     '3094','4168','4169','30931','3129','3095','3099','3098','3092','4189','3746')
GROUP BY 1, 2
ORDER BY n DESC;


-- ----------------------------------------------------------------------------
-- Q7  [F5] Why the Excel holds 25,214 rows where mst_vehicle holds 26,370 for
--     the same 22 plants. Tests the "Excel only includes vehicles with a widgets
--     row" hypothesis. Aggregate only.
-- ----------------------------------------------------------------------------
SELECT m.deployment_status,
       CASE WHEN t.device_id IS NULL THEN 'no widgets row' ELSE 'has widgets row' END AS widgets,
       COUNT(*) AS n
FROM `ap_masters`.`mst_vehicle` m
LEFT JOIN `ap_widgets`.`tb_vehiclemaster` t ON t.device_id = m.device_id
WHERE m.plant_id IN ('3093','3532','3528','3097','3604','3461','3096','3128','4170','4167','3605',
                     '3094','4168','4169','30931','3129','3095','3099','3098','3092','4189','3746')
GROUP BY 1, 2
ORDER BY n DESC;
