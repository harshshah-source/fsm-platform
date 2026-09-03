/*
 * #309 probe — read-only. Reports the live (work_type, status) distribution on `tickets` and
 * flags every pair outside the legal map derived from the writers (see
 * `test/ticketing/work-type-status-invariant.e2e-spec.ts`, which owns the map).
 *
 *   Usage (from apps/backend):
 *     node scripts/probe-work-type-status.cjs                       # DATABASE_URL (dev)
 *     node scripts/probe-work-type-status.cjs "postgres://…/fsm_test"
 *
 * Issues no writes and opens no transaction — safe against production-shaped data. Exit code is 1
 * when violating rows exist, so it doubles as a pre-migration gate.
 */
require('dotenv/config');
const { Client } = require('pg');

/** The legal map. Keep in step with the spec's LEGAL_PAIRS (the spec pins the two together). */
const LEGAL = {
  TROUBLESHOOT: ['OPEN', 'SUBMITTED', 'VERIFICATION_PENDING', 'ESCALATED', 'CLOSED', 'FAILED_VERIFICATION', 'CLOSED_AUTO_RECOVERY', 'CLOSED_NON_OPERATIONAL'],
  INSTALL: ['REQUESTED', 'SCHEDULED', 'ON_SITE', 'FITTED', 'ACTIVATED', 'CLOSED', 'FAILED_ACTIVATION', 'CLOSED_NON_OPERATIONAL'],
  RECOVERY: ['REQUESTED', 'SCHEDULED', 'ON_SITE', 'COLLECTED', 'RECEIVED_AT_WAREHOUSE', 'CLOSED', 'FAILED_RECOVERY', 'CLOSED_NON_OPERATIONAL'],
};

(async () => {
  const url = process.argv[2] || process.env.DATABASE_URL;
  if (!url) throw new Error('no DATABASE_URL and no url argument');
  const client = new Client({ connectionString: url.replace(/\?.*$/, '') });
  await client.connect();

  const { rows: [{ db }] } = await client.query('SELECT current_database() AS db');
  const { rows: dist } = await client.query(
    `SELECT work_type::text AS work_type, status::text AS status, COUNT(*)::int AS rows
       FROM tickets GROUP BY 1, 2 ORDER BY 1, 2`,
  );
  const { rows: [{ total }] } = await client.query('SELECT COUNT(*)::int AS total FROM tickets');
  const { rows: checks } = await client.query(
    `SELECT conname, pg_get_constraintdef(oid) AS def
       FROM pg_constraint WHERE conrelid = 'tickets'::regclass AND contype = 'c' ORDER BY conname`,
  );

  console.log(`database: ${db} — ${total} ticket rows`);
  console.table(dist.map((r) => ({ ...r, legal: (LEGAL[r.work_type] ?? []).includes(r.status) })));
  console.log('tickets CHECK constraints:');
  console.table(checks);

  const bad = dist.filter((r) => !(LEGAL[r.work_type] ?? []).includes(r.status));
  if (bad.length === 0) {
    console.log('PROBE CLEAN — 0 rows outside the legal map.');
  } else {
    console.log(`PROBE DIRTY — ${bad.reduce((s, r) => s + r.rows, 0)} rows across ${bad.length} illegal pair(s):`);
    console.table(bad);
  }
  await client.end();
  process.exit(bad.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error('probe failed:', e.message);
  process.exit(2);
});
