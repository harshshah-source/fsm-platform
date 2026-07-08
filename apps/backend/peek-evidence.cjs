// One-off evidence queries for the cold-drain explanation (delete after use).
const { Client } = require('pg');
const c = new Client({ connectionString: process.argv[2] });
const q = async (label, sql) => {
  const r = await c.query(sql);
  console.log(`\n== ${label} ==`);
  console.table(r.rows);
};
const run = async () => {
  await c.connect();
  await q('run 456 window + volume', `SELECT COUNT(*) AS rows, COUNT(DISTINCT device_id) AS devices,
    MIN(gps_datetime) AS min_gps, MAX(gps_datetime) AS max_gps
    FROM raw_device_snapshots WHERE run_id = 456`);
  await q('resume cursor run 456 started from (last SUCCESS/PARTIAL with cursor before it)',
    `SELECT run_id, status, cursor, data_as_of, finished_at FROM snapshot_runs
     WHERE run_id < 456 AND status IN ('SUCCESS','PARTIAL') AND cursor IS NOT NULL
     ORDER BY run_id DESC LIMIT 3`);
  await q('rows-per-device distribution (run 456)', `SELECT n AS rows_per_device, COUNT(*) AS devices
    FROM (SELECT device_id, COUNT(*) AS n FROM raw_device_snapshots WHERE run_id = 456
          GROUP BY device_id) d
    GROUP BY n ORDER BY n DESC LIMIT 8`);
  await q('single-row devices (read once, never re-seen)', `SELECT COUNT(*) AS devices_read_once
    FROM (SELECT device_id FROM raw_device_snapshots WHERE run_id = 456
          GROUP BY device_id HAVING COUNT(*) = 1) s`);
  await c.end();
};
run().catch(async (e) => { console.error(e.message); await c.end(); process.exit(1); });
