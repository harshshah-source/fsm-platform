// One-off progress peek (delete after use): in-flight snapshot run's chunk count + rows so far.
const { Client } = require('pg');
const c = new Client({ connectionString: process.argv[2] });
c.connect()
  .then(() =>
    c.query(`SELECT r.run_id, r.status, r.started_at,
      (SELECT COUNT(*) FROM snapshot_run_chunks ch WHERE ch.run_id = r.run_id) AS chunks,
      (SELECT COUNT(*) FROM raw_device_snapshots s WHERE s.run_id = r.run_id) AS rows_ingested
      FROM snapshot_runs r ORDER BY r.run_id DESC LIMIT 2`),
  )
  .then(async (r) => {
    console.table(r.rows);
    await c.end();
  })
  .catch(async (e) => { console.error(e.message); await c.end(); process.exit(1); });
