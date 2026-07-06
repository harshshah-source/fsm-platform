/**
 * The e2e suite must NOT run against the developer's live `DATABASE_URL`: once a real AutoPlant sync
 * has loaded the production org graph (~17.9k devices) into that database, the full-fleet operations
 * (`DeviceStateService.recompute`, fleet-uptime aggregation) iterate every row and blow past the 5s
 * test timeout. So tests run against an isolated sibling database on the SAME server.
 *
 * Derivation: `TEST_DATABASE_URL` wins if set; otherwise we take `DATABASE_URL` and suffix the
 * database name with `_test` (e.g. `.../fsm` → `.../fsm_test`), preserving host/credentials/params.
 * The sibling DB is a one-time superuser bootstrap (it needs the PostGIS extension, per
 * `20260621140000_add_geography_postgis`) — see `.env.example`.
 */
export function testDatabaseUrl(): string {
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
