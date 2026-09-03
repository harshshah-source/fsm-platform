/*
 * #323 probe (CB-11 + AR-9c) — read-only. Measures what the two mapping defects have already written,
 * so the slice can state the residue rather than guess at it.
 *
 *   Usage (from apps/backend):
 *     node scripts/probe-source-sentinels.cjs                       # DATABASE_URL (dev)
 *     node scripts/probe-source-sentinels.cjs "postgres://…/fsm_test"
 *
 * Two questions:
 *
 *  1. **CB-11** — how many `device_states.trip_creation_datetime` values are already below the
 *     plausibility floor (MySQL's `0000-00-00 00:00:00` lands near 1899-11-30). The fix stops new ones;
 *     the issue explicitly defers cleaning up old ones and asks only that they be counted here.
 *  2. **AR-9c** — how many devices carry a sentinel word as their id (`NA`/`NULL`/`null`). Those are
 *     rows the snapshot path journalled and the masters path could never create, which is what left
 *     them unreachable. The fix drops them at the mapping layer going forward.
 *
 * Issues no writes and opens no transaction — safe against production-shaped data. Exit code is always
 * 0: this reports, it does not gate.
 */
require('dotenv/config');
const { Client } = require('pg');

const FLOOR = '2000-01-01T00:00:00.000Z';
const SENTINELS = ['', 'NA', 'NULL', 'null'];

(async () => {
  const url = process.argv[2] || process.env.DATABASE_URL;
  if (!url) throw new Error('no DATABASE_URL and no url argument');
  const client = new Client({ connectionString: url.replace(/\?.*$/, '') });
  await client.connect();

  const {
    rows: [{ db }],
  } = await client.query('SELECT current_database() AS db');

  const {
    rows: [trip],
  } = await client.query(
    `SELECT COUNT(*)::int                                   AS below_floor,
            COUNT(DISTINCT device_id)::int                  AS devices,
            MIN(trip_creation_datetime)                     AS earliest,
            MAX(trip_creation_datetime)                     AS latest,
            (SELECT COUNT(*) FROM device_states
              WHERE trip_creation_datetime IS NOT NULL)::int AS total_non_null
       FROM device_states
      WHERE trip_creation_datetime IS NOT NULL
        AND trip_creation_datetime < $1`,
    [FLOOR],
  );

  const { rows: sentinelRows } = await client.query(
    `SELECT d.device_id,
            (SELECT COUNT(*) FROM device_states s WHERE s.device_id = d.device_id)::int AS states
       FROM devices d
      WHERE btrim(d.device_id) = ANY($1::text[])
      ORDER BY d.device_id`,
    [SENTINELS],
  );

  console.log(`database: ${db}`);
  console.log('');
  console.log('CB-11 — trip_creation_datetime below the 2000-01-01 floor');
  console.log(`  rows              : ${trip.below_floor} of ${trip.total_non_null} non-null`);
  console.log(`  distinct devices  : ${trip.devices}`);
  console.log(`  range             : ${trip.earliest ?? '—'} .. ${trip.latest ?? '—'}`);
  console.log('');
  console.log('AR-9c — devices whose id is a sentinel word');
  if (sentinelRows.length === 0) {
    console.log('  none');
  } else {
    for (const r of sentinelRows) console.log(`  ${JSON.stringify(r.device_id)} — ${r.states} device_states row(s)`);
  }

  await client.end();
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
