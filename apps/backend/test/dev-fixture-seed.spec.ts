import { describe, expect, it } from 'vitest';
import { readDevFixtureConfig } from '../src/auth/dev-fixture-seed.config';

/**
 * #336 — the guard on the *walkable-state* dev fixtures, tested WITHOUT a database.
 *
 * These fixtures exist because 17 findings in the 2026-09-02 module-gap survey were unresolvable for
 * want of test data, not for want of looking: the one Service-Engineer login has no `engineer_master`
 * row, `verification_runs` holds zero rows, and van stock / component requests / shadow use are all
 * empty, so the SE half of `vouchers`, `inventory`, `scheduling` and the whole of `verification`
 * cannot be walked at all.
 *
 * **Why a second flag rather than a step inside `runDevSeed`.** The absence this closes is deliberate
 * and recorded twice — `test/fixtures/shared-auth-se.ts` ("a fixture engineer row has no business
 * appearing in a development database's engineer directory") and `test/global-setup.ts:46-47`
 * ("Test-only on purpose: seedAuthFixtureUsers is also called by the gated dev-seed runner"). The dev
 * database is an ingested mirror of production: an operator reading its engineer directory, its
 * verification queue or its company tiers must not find rows a seeder invented. So `ALLOW_DEV_SEED`
 * keeps meaning exactly what it meant — mint the logins — and this asks for its own answer. Setting
 * the login flag must NOT be enough; that is the property this file exists to pin.
 *
 * Same shape as `readDevSeedConfig` (#194) for the same reasons: a pure function of an `env` object,
 * so it is directly unit-testable and `test/setup-env.ts`'s allowlist scrub cannot change what the
 * seeder does under test. And, as there, the refusal is the contract that gets pinned — a seeder that
 * writes invented operational rows into a database an operator trusts is a worse defect than the
 * blocked walks it fixes.
 */

describe('#336 walkable-fixture guard — readDevFixtureConfig', () => {
  it('is not granted by the dev-login opt-in: ALLOW_DEV_SEED alone leaves it refused', () => {
    const cfg = readDevFixtureConfig({ ALLOW_DEV_SEED: 'true', NODE_ENV: 'development' });

    expect(cfg.allowed).toBe(false);
    // The refusal has to name the flag that would grant it, or the operator is left guessing which
    // of two opt-ins they are missing.
    expect(cfg.allowed === false && cfg.reason).toMatch(/SEED_DEV_WALK_FIXTURES/);
  });

  it('refuses under NODE_ENV=production even with every opt-in set — no flag overrides it', () => {
    const cfg = readDevFixtureConfig({
      SEED_DEV_WALK_FIXTURES: 'true',
      ALLOW_DEV_SEED: 'true',
      NODE_ENV: 'production',
    });

    expect(cfg.allowed).toBe(false);
    expect(cfg.allowed === false && cfg.reason).toMatch(/production/i);
  });
});
