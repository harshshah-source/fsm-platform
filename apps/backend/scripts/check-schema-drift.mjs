/*
 * #107 slice 2 — schema-drift gate for CI.
 *
 *   node scripts/check-schema-drift.mjs             # compare against the committed baseline
 *   node scripts/check-schema-drift.mjs --write     # regenerate the baseline (deliberate act)
 *
 * Diffs a database built purely by `prisma migrate deploy` against `schema.prisma`. Anything the
 * migration set does not reproduce is drift.
 *
 * WHY A BASELINE INSTEAD OF A ZERO-DRIFT ASSERTION
 * ------------------------------------------------
 * As of 2026-07-22 this repo already has drift across 22 unrelated tables — 18 renamed indexes, one
 * renamed FK, and some FK/default annotation differences — because hand-written migrations used short
 * index names where Prisma's introspected default naming differs (`zpsm_month_idx` vs
 * `zm_performance_summary_monthly_month_idx`). It is cosmetic: naming, not structure. Discovered while
 * verifying #144; normalising it is deferred to #152.
 *
 * A plain `--exit-code` assertion would therefore fail on day one and be muted, which defeats the
 * point of #107. The obvious alternative — filtering out lines matching "Renamed index" — buys a green
 * build at the cost of making a GENUINE rename invisible forever.
 *
 * So we pin the *known* drift in a committed baseline and fail on anything NEW. That tolerates the
 * pre-existing mess, still catches a genuine rename, and makes the debt visible in a reviewable file
 * that shrinks to empty when #152 lands. Baseline entries that DISAPPEAR are not a failure — that is
 * drift being paid down.
 *
 * The check that actually matters for the #144 class of defect (a migration applied to a live database
 * but never committed) is caught by this regardless of naming: an untracked migration's columns simply
 * do not exist in the migrated database, so they surface as new structural drift.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const backendRoot = join(here, '..');
const BASELINE = join(backendRoot, 'prisma', 'drift-baseline.txt');
const WRITE = process.argv.includes('--write');

/** Strip ANSI, trim trailing space, drop blank lines — so cosmetic formatting never flips the gate. */
function normalize(raw) {
  return raw
    .replace(/\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.length > 0 && !l.startsWith('Loaded Prisma config') && !l.startsWith('#'));
}

let out;
try {
  out = execFileSync(
    'npx',
    ['--no-install', 'prisma', 'migrate', 'diff', '--from-config-datasource', '--to-schema', './prisma/schema.prisma'],
    { cwd: backendRoot, encoding: 'utf8', shell: true },
  );
} catch (err) {
  console.error('prisma migrate diff failed to run:\n', err.stdout ?? '', err.stderr ?? '');
  process.exit(1);
}

const lines = normalize(out);
const isEmpty = lines.length === 0 || lines.some((l) => l.includes('No difference detected'));
const current = isEmpty ? [] : lines;

if (WRITE) {
  writeFileSync(BASELINE, `${current.join('\n')}\n`, 'utf8');
  console.log(`baseline written: ${current.length} line(s) -> ${BASELINE}`);
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error(`missing baseline ${BASELINE}. Generate it with: node scripts/check-schema-drift.mjs --write`);
  process.exit(1);
}

const baseline = new Set(normalize(readFileSync(BASELINE, 'utf8')));
const added = current.filter((l) => !baseline.has(l));

if (added.length > 0) {
  console.error('\nNEW schema drift — the migration set does not reproduce schema.prisma.\n');
  console.error('This usually means a migration was applied to a database but never committed,');
  console.error('or schema.prisma was edited without a matching migration.\n');
  for (const l of added) console.error(`  + ${l}`);
  console.error(`\n${added.length} new drift line(s). Baseline: ${BASELINE}`);
  console.error('If this drift is intentional and understood, re-baseline deliberately:');
  console.error('  node scripts/check-schema-drift.mjs --write\n');
  process.exit(1);
}

const paidDown = [...baseline].filter((l) => !current.includes(l));
console.log(`schema drift OK — no new drift (${current.length} known baseline line(s)).`);
if (paidDown.length > 0) {
  console.log(`${paidDown.length} baseline line(s) no longer drift — re-baseline to shrink the file (#152).`);
}
