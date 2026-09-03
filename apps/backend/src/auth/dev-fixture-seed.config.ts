/**
 * Walkable dev fixtures — the guard (#336).
 *
 * The 2026-09-02 module-gap survey left 17 findings unresolved for want of test data rather than for
 * want of looking: `se.north@fsm.test` has a `users` row and no `engineer_master` row, so every
 * SE-facing path 404s; `verification_runs` holds zero rows; van stock, component requests and shadow
 * use are all empty. This module gates the seeder that makes those walks possible.
 *
 * **Why this is a second flag and not a step inside `runDevSeed`.** The gap it closes is a deliberate
 * absence, recorded in two places — `test/fixtures/shared-auth-se.ts` ("a fixture engineer row has no
 * business appearing in a development database's engineer directory") and `test/global-setup.ts`
 * ("Test-only on purpose: seedAuthFixtureUsers is also called by the gated dev-seed runner"). That
 * reasoning is sound and survives: the dev database is an ingested mirror of production, and an
 * operator reading its engineer directory, verification queue or company tiers must not find rows a
 * seeder invented. So `ALLOW_DEV_SEED` keeps its exact meaning — mint the `*@fsm.test` logins — and
 * the operational rows ask for their own, separate answer. Setting the login flag is deliberately not
 * enough.
 *
 * A pure function of an `env` object rather than `process.env`, matching `dev-seed.config.ts` and
 * `ops-explorer.config.ts`: directly unit-testable, and callers pass env explicitly so
 * `test/setup-env.ts`'s allowlist scrub cannot change what the seeder does under test.
 */

export type DevFixtureConfig = { allowed: true } | { allowed: false; reason: string };

/** Env values accepted as true — the same vocabulary `ops-explorer.config.ts` established. */
function isAffirmative(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

export function readDevFixtureConfig(env: NodeJS.ProcessEnv = process.env): DevFixtureConfig {
  // Checked before the opt-in, and unconditional: the flag exists to be set on a development box, so
  // a copied `.env` carrying it must still be refused where it matters most. Same asymmetry, and the
  // same reasoning, as `readDevSeedConfig`.
  if ((env.NODE_ENV ?? '').trim().toLowerCase() === 'production') {
    return {
      allowed: false,
      reason:
        'Refusing to seed walkable dev fixtures: NODE_ENV=production. This seeder writes invented ' +
        'operational rows — an engineer and their coverage, verification runs, van stock, a tiered ' +
        'ticket, a leave request — which would be indistinguishable from real work on a production ' +
        'database. SEED_DEV_WALK_FIXTURES does not override this.',
    };
  }

  if (!isAffirmative(env.SEED_DEV_WALK_FIXTURES)) {
    return {
      allowed: false,
      reason:
        'Refusing to seed walkable dev fixtures: SEED_DEV_WALK_FIXTURES is not set. This is a ' +
        'separate opt-in from ALLOW_DEV_SEED on purpose — that flag mints the *@fsm.test logins, ' +
        'while this one writes operational rows (an engineer, coverage, verification runs, van ' +
        'stock, a tiered ticket, a leave request) into a database whose engineer directory and ' +
        'queues an operator reads. Set SEED_DEV_WALK_FIXTURES=true only on a development database ' +
        'you are willing to see fixture rows in.',
    };
  }

  return { allowed: true };
}
