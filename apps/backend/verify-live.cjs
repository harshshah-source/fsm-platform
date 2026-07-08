// One-off post-sync verification against the LIVE dev DB (delete after use).
const { Client } = require('pg');
const c = new Client({ connectionString: process.argv[2] });
const q = async (label, sql) => {
  const r = await c.query(sql);
  console.log(`\n== ${label} ==`);
  console.table(r.rows);
};
const run = async () => {
  await c.connect();
  await q('master_sync_runs (last 3)', `SELECT run_id, status, started_at, finished_at, error,
    jsonb_pretty(entity_stats) AS entity_stats FROM master_sync_runs ORDER BY run_id DESC LIMIT 3`);
  await q('master_sync_rejects by entity/reason (latest run)', `SELECT entity, reason, COUNT(*) AS n
    FROM master_sync_rejects WHERE run_id = (SELECT MAX(run_id) FROM master_sync_runs)
    GROUP BY entity, reason ORDER BY n DESC`);
  await q('snapshot_runs (last 3)', `SELECT run_id, status, started_at, finished_at, data_as_of, cursor
    FROM snapshot_runs ORDER BY run_id DESC LIMIT 3`);
  await q('raw_device_snapshots', `SELECT COUNT(*) AS rows, COUNT(DISTINCT device_id) AS devices,
    MIN(gps_datetime) AS min_gps, MAX(gps_datetime) AS max_gps FROM raw_device_snapshots`);
  await q('device_states', `SELECT COUNT(*) AS rows, MAX(computed_at) AS max_computed_at,
    COUNT(*) FILTER (WHERE sla_bucket IS NOT NULL) AS with_bucket FROM device_states`);
  await q('device_states by sla_bucket', `SELECT sla_bucket, COUNT(*) AS n FROM device_states
    GROUP BY sla_bucket ORDER BY n DESC`);
  await q('org graph counts', `SELECT (SELECT COUNT(*) FROM plants) AS plants,
    (SELECT COUNT(*) FROM company_master) AS companies, (SELECT COUNT(*) FROM vehicles) AS vehicles,
    (SELECT COUNT(*) FROM devices) AS devices,
    (SELECT COUNT(*) FROM zone_mappings WHERE status = 'PENDING') AS pending_zone_maps`);
  await c.end();
};
run().catch(async (e) => { console.error(e.message); await c.end(); process.exit(1); });
