import { testDatabaseUrl } from './test-db-url';

/**
 * Per-worker env normalization for the test suite. Runs after `dotenv/config` has loaded `.env` and
 * before any Nest module / PrismaService boots.
 *
 * #182 — this is an ALLOWLIST, not a deny-list. A deny-list only neutralises the specific keys it
 * names, so the *next* flag anyone adds to `.env` reaches the suite unmodified and silently changes
 * test outcomes (this has already happened twice: `BUSINESS_SWEEPS_ENABLED`, and `DEV_AUTH_ZONE`
 * documented but unenforced in `.env.example`). Inverting closes the class: every key in the
 * application's own namespace is deleted first, then the handful the suite actually depends on are
 * set back to their fixed test value. A key OUTSIDE the app namespace (`PATH`, `NODE_ENV`, `CI`,
 * `BOOK8_RUN`, …) is never touched — see `sanitizeTestEnv` below for the exact boundary.
 */

/** Non-prefixed application env vars — deleted, then a subset re-set to a fixed test value below. */
const APP_NAMESPACE_LITERALS = [
  'DATABASE_URL',
  'TEST_DATABASE_URL',
  'JWT_ACCESS_SECRET',
  'ADMIN_ORIGIN',
  'BODY_LIMIT_JSON',
  'PORT',
  'PUBLIC_API_URL',
  'INSTALL_CSV_MAX_ROWS',
  'DEV_AUTH_ZONE',
];

/**
 * Prefix families that own a whole cluster of vars each (11 `BUSINESS_SWEEP_*_CRON` names, 7
 * `AUTOPLANT_MYSQL_*` credentials, etc. — see #182 R1). `BUSINESS_SWEEP` deliberately has no trailing
 * underscore so it also catches `BUSINESS_SWEEPS_ENABLED`. A NEW var in any of these families
 * (the "next flag" this issue exists to stop) is neutralised automatically — it never needs adding
 * here by name.
 */
const APP_NAMESPACE_PREFIXES = [
  'AUTOPLANT_',
  'BUSINESS_SWEEP',
  'INGESTION_',
  'PARTITION_',
  'PLANT_ELIGIBILITY_',
  'DB_',
];

const isAppNamespaceKey = (key: string): boolean =>
  APP_NAMESPACE_LITERALS.includes(key) || APP_NAMESPACE_PREFIXES.some((prefix) => key.startsWith(prefix));

/**
 * Deletes every env var in the application's own namespace, then re-sets the handful the suite is
 * written against to a fixed test value. Exported (rather than only run inline below) so the
 * allowlist boundary itself is unit-testable — see `test/setup-env-allowlist.spec.ts` (#182 AC-1).
 *
 * Deliberately NOT a whole-environment wipe (#182 R3): `PATH`/`PATHEXT`/`ComSpec`/`SystemRoot` are
 * needed by `global-setup.ts`'s `execFileSync(..., { shell: true })`; `NODE_ENV` is consulted by
 * vitest/SWC/Node's own module resolution though never read by this app; `BOOK8_RUN`/`BOOK_DATASET`
 * are the Book8 harness's own opt-in gates and deleting them would make it silently skip. None of
 * those match `isAppNamespaceKey`, so they survive untouched without being special-cased here.
 */
export function sanitizeTestEnv(env: NodeJS.ProcessEnv): void {
  // Capture BEFORE deleting — testDatabaseUrl() reads DATABASE_URL/TEST_DATABASE_URL from `env`, and
  // both are in the deletion set below.
  const dbUrl = testDatabaseUrl(env);

  for (const key of Object.keys(env)) {
    if (isAppNamespaceKey(key)) delete env[key];
  }

  // The fixed test values (#182 R1.a). DEV_AUTH_ZONE and AUTOPLANT_MYSQL_* stay deleted — unset is
  // itself the correct value (74 specs assert the dev ZM's default zone_id 1; the integration is
  // designed unset in test so the in-memory SourceReader is used, see #182 R1.a).
  env.DATABASE_URL = dbUrl;
  env.JWT_ACCESS_SECRET = 'test-jwt-access-secret-000000000000000000'; // #98: 32+ chars, non-default
  env.BUSINESS_SWEEPS_ENABLED = 'false';
  env.INGESTION_SCHEDULER_ENABLED = 'false';
  env.PARTITION_MAINTENANCE_ENABLED = 'false';

  // Two named, deliberate exceptions outside the app namespace (#182 R3) — not new flags to track,
  // just two things that could otherwise leak a developer's local Postgres/OS config into the suite:
  //
  // PG* — node-postgres (via @prisma/adapter-pg) falls back to PGHOST/PGPORT/PGUSER/PGDATABASE/…
  // for any connection field the URL doesn't specify. The test DB URL above is fully qualified, so
  // nothing legitimate needs these; a stray PGDATABASE could otherwise silently redirect the suite.
  for (const key of Object.keys(env)) {
    if (key.startsWith('PG')) delete env[key];
  }
  // TZ — the DB session timezone is already pinned to UTC independently (prisma.service.ts pool
  // startup param), but Node-side `new Date(...)` rendering in specs still follows process TZ.
  // Pinning removes a whole class of "passes on my machine, fails in CI".
  env.TZ = 'UTC';
}

sanitizeTestEnv(process.env);
