/*
 * #327 probe (RC-13) — read-only. Reports whether the two `max+1` sequence mints in
 * `override.service.ts` have ever landed a duplicate: `plant_batch_assignments.stop_sequence`
 * within one schedule, and `batch_assignment_tickets.sort_order` within one live batch.
 *
 *   Usage (from apps/backend):
 *     node scripts/probe-stop-sequence-duplicates.cjs                       # DATABASE_URL (dev)
 *     node scripts/probe-stop-sequence-duplicates.cjs "postgres://…/fsm_test"
 *
 * The issue makes a DB unique on `(schedule_id, stop_sequence)` optional and conditional — "only if
 * the probe shows no existing duplicates" (#155's rule). This answers that question, and the second
 * half of it that the issue does not ask but the same mint creates: `sort_order` is minted the same
 * way inside the same transaction.
 *
 * Issues no writes and opens no transaction — safe against production-shaped data. Exit code is 1
 * when duplicates exist, so it doubles as a pre-migration gate.
 */
require('dotenv/config');
const { Client } = require('pg');

(async () => {
  const url = process.argv[2] || process.env.DATABASE_URL;
  if (!url) throw new Error('no DATABASE_URL and no url argument');
  const client = new Client({ connectionString: url.replace(/\?.*$/, '') });
  await client.connect();

  const { rows: [{ db }] } = await client.query('SELECT current_database() AS db');
  const { rows: [counts] } = await client.query(
    `SELECT (SELECT COUNT(*) FROM plant_batch_assignments)::int AS batches,
            (SELECT COUNT(*) FROM batch_assignment_tickets WHERE removed_at IS NULL)::int AS live_rows,
            (SELECT COUNT(*) FROM work_schedules)::int AS schedules`,
  );

  // Duplicate stop numbers within one schedule.
  const { rows: stopDupes } = await client.query(
    `SELECT schedule_id::text, stop_sequence, COUNT(*)::int AS rows
       FROM plant_batch_assignments
      GROUP BY 1, 2 HAVING COUNT(*) > 1
      ORDER BY 3 DESC, 1, 2 LIMIT 50`,
  );
  // Duplicate sort orders within one batch, live rows only — `nextSortOrder` filters `removedAt: null`,
  // so a removed row legitimately shares its number with the row that replaced it.
  const { rows: sortDupes } = await client.query(
    `SELECT batch_id::text, sort_order, COUNT(*)::int AS rows
       FROM batch_assignment_tickets WHERE removed_at IS NULL
      GROUP BY 1, 2 HAVING COUNT(*) > 1
      ORDER BY 3 DESC, 1, 2 LIMIT 50`,
  );
  // Every unique index already on the two tables — what a new one would have to coexist with.
  const { rows: idx } = await client.query(
    `SELECT indexrelid::regclass::text AS index, indrelid::regclass::text AS "table",
            pg_get_indexdef(indexrelid) AS def
       FROM pg_index
      WHERE indisunique AND indrelid IN ('plant_batch_assignments'::regclass, 'batch_assignment_tickets'::regclass)
      ORDER BY 2, 1`,
  );

  console.log(
    `database: ${db} — ${counts.schedules} schedules, ${counts.batches} plant batches, ${counts.live_rows} live batch-ticket rows`,
  );
  console.log('unique indexes in place:');
  console.table(idx);

  const report = (label, rows) => {
    if (rows.length === 0) {
      console.log(`${label}: CLEAN — 0 duplicate groups.`);
      return 0;
    }
    console.log(`${label}: DIRTY — ${rows.length} duplicate group(s):`);
    console.table(rows);
    return rows.length;
  };

  const bad =
    report('(schedule_id, stop_sequence)', stopDupes) + report('(batch_id, sort_order) live rows', sortDupes);

  await client.end();
  process.exit(bad === 0 ? 0 : 1);
})().catch((e) => {
  console.error('probe failed:', e.message);
  process.exit(2);
});
