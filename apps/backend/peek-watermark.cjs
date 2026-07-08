// One-off (delete after use): how close is run 456's ingest watermark to real time?
const { Client } = require('pg');
const c = new Client({ connectionString: process.argv[2] });
c.connect()
  .then(() =>
    c.query(`SELECT MAX(gps_datetime) AS max_gps, NOW() AS db_now,
      NOW() - MAX(gps_datetime) AS lag
      FROM raw_device_snapshots WHERE run_id = 456`),
  )
  .then(async (r) => {
    console.table(r.rows);
    await c.end();
  })
  .catch(async (e) => { console.error(e.message); await c.end(); process.exit(1); });
