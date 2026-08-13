import { seedAuthFixtureUsers, type AuthFixtureSeedClient, FIXTURE_EMAILS } from './auth-fixture-seed';
import { readDevSeedConfig } from './dev-seed.config';

/**
 * Dev-login seed — the runner (#194).
 *
 * `seedAuthFixtureUsers` has always been able to mint the eight `*@fsm.test` logins; what did not
 * exist was a committed way to point it at a *development* database. Its only caller was
 * `test/global-setup.ts`, i.e. `fsm_test`, so a clean clone could migrate, seed, start the backend —
 * and still 401 on every login, with no diagnostic (`validateCredentials` deliberately cannot
 * distinguish "no credential row" from "wrong password"). This is that missing entrypoint, in
 * library form; `src/seed-dev.ts` is the thin `npm run seed:dev` wrapper around it.
 *
 * It composes rather than duplicates: the same fixture list, the same `ensureCredential` write path,
 * the same UUIDs and emails the e2e suite logs in as. A second definition of "the dev accounts" is
 * how the test suite and a developer's browser start disagreeing about who exists.
 *
 * Everything it refuses to do lives in `dev-seed.config.ts`. Read that file first.
 */

/** The operational zones the fixture ZMs are scoped to. UNZONED is a holding zone — no user owns it. */
const REQUIRED_ZONES = ['North', 'South', 'East', 'West'] as const;

/** The accounts this seeder is responsible for, re-exported so tests and docs cite one list. */
export const DEV_SEED_FIXTURE_EMAILS = FIXTURE_EMAILS;

export interface DevSeedSummary {
  /** Accounts ensured (created or already present — `ensureCredential` never rotates an existing hash). */
  accounts: number;
  emails: readonly string[];
  /** False when `DEV_SEED_PASSWORD` replaced the well-known default — worth printing, never the value. */
  usedDefaultPassword: boolean;
}

/**
 * Which of the required zones are absent from `presentZoneNames`, in canonical order.
 *
 * Pure, and separated from the query for a reason: `seedAuthFixtureUsers` resolves each ZM's zone by
 * NAME, and on an unseeded database that lookup misses silently — the upsert still succeeds and
 * writes a `ZONAL_MANAGER` with a null `zone_id`. That account logs in fine and then 403s on every
 * zone-scoped route, which is a harder thing to diagnose than the 401 this issue exists to remove.
 * So the documented order (migrate → seed → seed:dev) is enforced here rather than only written down.
 */
export function missingDevSeedZones(presentZoneNames: readonly string[]): string[] {
  const present = new Set(presentZoneNames);
  return REQUIRED_ZONES.filter((name) => !present.has(name));
}

/**
 * Seeds the dev logins, or throws with a reason an operator can act on.
 *
 * `client` is the narrow `AuthFixtureSeedClient` rather than a full `PrismaClient` so a caller can
 * hand it a transaction client — which is how the e2e proves creation-from-empty without leaving the
 * shared, never-truncated `fsm_test` database (#156) missing its credentials for every later file.
 */
export async function runDevSeed(
  client: AuthFixtureSeedClient,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DevSeedSummary> {
  const config = readDevSeedConfig(env);
  if (!config.allowed) throw new Error(config.reason);

  const zones = await client.zone.findMany({ select: { name: true } });
  const missing = missingDevSeedZones(zones.map((z) => z.name));
  if (missing.length > 0) {
    throw new Error(
      `Refusing to seed dev logins: the operational zones ${missing.join(', ')} do not exist. ` +
        'Zonal-manager accounts are scoped by zone name, so seeding now would create managers with no ' +
        'zone — a login that authenticates and then 403s everywhere. Run `npm run seed` first ' +
        '(migrate → seed → seed:dev → start).',
    );
  }

  const accounts = await seedAuthFixtureUsers(client, config.password);

  return {
    accounts,
    emails: FIXTURE_EMAILS,
    usedDefaultPassword: env.DEV_SEED_PASSWORD === undefined,
  };
}
