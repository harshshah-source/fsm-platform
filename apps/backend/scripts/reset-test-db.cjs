/*
 * #180 AC-8 — hand-runnable truncate + reseed of the isolated test database (`fsm_test`). Runs the
 * exact sequence `test/global-setup.ts` runs automatically before every vitest run: migrate deploy ->
 * TRUNCATE ... RESTART IDENTITY (#180 R2, kept in sync with test/truncate-test-db.ts) ->
 * seedOrgReferenceData. Needs a build first (`pnpm build`) since — like scripts/reset-reseed-ses.cjs
 * — it requires compiled dist/ output rather than transforming TypeScript itself.
 *
 *   pnpm test:reset
 *
 * Never boots the Nest app / constructs PrismaService — a bare PrismaClient only (#180 R2, AC-9).
 */
require('dotenv/config');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('../dist/generated/prisma/client');
const { seedOrgReferenceData } = require('../dist/org/org-seed');

const backendRoot = path.join(__dirname, '..');

// Mirrors test/test-db-url.ts: TEST_DATABASE_URL wins; else DATABASE_URL with the db name suffixed
// `_test` (…/fsm -> …/fsm_test).
function testDatabaseUrl() {
  const explicit = process.env.TEST_DATABASE_URL?.trim();
  if (explicit) return explicit;
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL is not set; cannot derive the isolated test database URL.');
  const url = new URL(base);
  const db = url.pathname.replace(/^\//, '');
  if (!db) throw new Error(`DATABASE_URL has no database name to derive a test DB from: ${base}`);
  url.pathname = `/${db.endsWith('_test') ? db : `${db}_test`}`;
  return url.toString();
}

// #180 R2 — kept in sync with test/truncate-test-db.ts; see that file for the full rationale
// (why TRUNCATE over ordered deletes, why no CASCADE, why RESTART IDENTITY is mandatory).
const TABLE_LIST_QUERY = `
  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ' ORDER BY c.relname) AS qualified
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND c.relispartition = false
    AND c.relname NOT IN ('spatial_ref_sys', '_prisma_migrations')
`;

async function truncateTestDatabase(prisma, databaseUrl) {
  const dbName = new URL(databaseUrl).pathname.replace(/^\//, '');
  if (!dbName.endsWith('_test')) {
    throw new Error(
      `refusing to truncate a database whose name does not end in "_test": "${dbName}". ` +
        'This operation is unrecoverable.',
    );
  }
  const rows = await prisma.$queryRawUnsafe(TABLE_LIST_QUERY);
  const tableList = rows[0]?.qualified;
  if (!tableList) return;
  await prisma.$executeRawUnsafe(`TRUNCATE ${tableList} RESTART IDENTITY`);
}

(async () => {
  const url = testDatabaseUrl();
  const env = { ...process.env, DATABASE_URL: url };
  const dbName = new URL(url).pathname.replace(/^\//, '');

  console.log(`Resetting "${dbName}" ...`);

  execFileSync('npx', ['--no-install', 'prisma', 'migrate', 'deploy'], {
    cwd: backendRoot,
    env,
    stdio: 'inherit',
    shell: true,
  });

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    await prisma.$connect();
    await truncateTestDatabase(prisma, url);
    const summary = await seedOrgReferenceData(prisma);
    console.log('Reset complete. Seeded:', summary);
  } finally {
    await prisma.$disconnect();
  }
})().catch((err) => {
  console.error('test:reset failed:', err);
  process.exit(1);
});
