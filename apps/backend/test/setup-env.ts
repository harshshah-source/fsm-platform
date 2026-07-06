import { testDatabaseUrl } from './test-db-url';

/**
 * Per-worker env normalization for the test suite. Runs after `dotenv/config` has loaded `.env` and
 * before any Nest module / PrismaService boots.
 *
 * 1. Neutralize AutoPlant MySQL env. The integration is DESIGNED to be UNSET in dev/test/CI (see
 *    `.env.example`): with it unset the SnapshotIngestionWorker uses the in-memory `SourceReader` and
 *    the `/api/integration/health` surface reports "not configured". Once a developer puts real
 *    AutoPlant credentials in `.env` (for `autoplant:ping` / a live sync) those same vars would
 *    otherwise flip `SOURCE_READER` to the real reader and make `source.connected` true — breaking
 *    the env-shape tests that assert the unconfigured baseline.
 * 2. Re-point `DATABASE_URL` at the ISOLATED test database (see `test-db-url.ts`). PrismaService
 *    reads `DATABASE_URL` at construction, so overriding it here keeps the suite off the developer's
 *    live DB — which may hold a full AutoPlant sync (~17.9k devices) that makes full-fleet recompute
 *    time out. globalSetup has already migrated + seeded that DB to the baseline the suite expects.
 */
for (const key of Object.keys(process.env)) {
  if (key.startsWith('AUTOPLANT_MYSQL')) delete process.env[key];
}

process.env.DATABASE_URL = testDatabaseUrl();
