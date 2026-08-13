import { describe, expect, it } from 'vitest';
import { missingDevSeedZones } from '../src/auth/dev-seed';
import { DEV_SEED_DEFAULT_PASSWORD, readDevSeedConfig } from '../src/auth/dev-seed.config';

/**
 * #194 — the guard on the dev-login seeder, tested WITHOUT a database.
 *
 * `seedAuthFixtureUsers` was deliberately walled off from `src/seed.ts` so a `pnpm seed` against a
 * real database could never mint `*@fsm.test` credentials. #194 builds the other half — a dev-only
 * entrypoint — and this spec is the wall that replaces the one being opened. A credential minter with
 * a well-known password that can be pointed at production is a worse defect than the one it fixes, so
 * the refusal is the part that gets pinned, not the seeding.
 *
 * Pure function over an `env` object (the `ops-explorer.config.ts` / `boot-config.ts` shape) rather
 * than `process.env`, for two reasons: it is directly unit-testable, and the caller passes env in
 * explicitly, so `test/setup-env.ts`'s allowlist scrub cannot change what the seeder does under test.
 */

describe('#194 dev-seed guard — readDevSeedConfig', () => {
  it('refuses by default, in every environment', () => {
    for (const env of [{}, { NODE_ENV: 'development' }, { NODE_ENV: 'test' }, { NODE_ENV: 'production' }]) {
      expect(readDevSeedConfig(env).allowed).toBe(false);
    }
  });

  it('allows only an explicit opt-in outside production', () => {
    expect(readDevSeedConfig({ ALLOW_DEV_SEED: 'true' }).allowed).toBe(true);
    expect(readDevSeedConfig({ ALLOW_DEV_SEED: 'true', NODE_ENV: 'development' }).allowed).toBe(true);
    expect(readDevSeedConfig({ ALLOW_DEV_SEED: 'true', NODE_ENV: 'test' }).allowed).toBe(true);
  });

  it('refuses under NODE_ENV=production even with the opt-in set — the flag cannot override it', () => {
    const cfg = readDevSeedConfig({ ALLOW_DEV_SEED: 'true', NODE_ENV: 'production' });
    expect(cfg.allowed).toBe(false);
    expect(cfg.allowed === false && cfg.reason).toMatch(/production/i);
  });

  it('states, in the refusal itself, what would make it run', () => {
    const cfg = readDevSeedConfig({ NODE_ENV: 'development' });
    expect(cfg.allowed).toBe(false);
    expect(cfg.allowed === false && cfg.reason).toContain('ALLOW_DEV_SEED');
  });

  it('treats anything that is not an affirmative as no opt-in', () => {
    for (const raw of ['', ' ', 'false', 'False', 'no', 'off', '0', 'ALLOW', 'true-ish']) {
      expect(readDevSeedConfig({ ALLOW_DEV_SEED: raw }).allowed).toBe(false);
    }
    // The affirmative vocabulary is the one `ops-explorer.config.ts` already established.
    for (const raw of ['true', 'TRUE', ' True ', '1', 'yes', 'on']) {
      expect(readDevSeedConfig({ ALLOW_DEV_SEED: raw }).allowed).toBe(true);
    }
  });

  it('keeps the well-known fixture password by default, and lets an env var replace it', () => {
    // Default is `correct-password` on purpose: `apps/admin/visual/manifest.mjs` CREDS hardcode it,
    // and AC-4 asks that `npm run visual:capture` work on a clean machine with no extra config.
    const dflt = readDevSeedConfig({ ALLOW_DEV_SEED: 'true' });
    expect(dflt.allowed === true && dflt.password).toBe(DEV_SEED_DEFAULT_PASSWORD);
    expect(DEV_SEED_DEFAULT_PASSWORD).toBe('correct-password');

    const custom = readDevSeedConfig({ ALLOW_DEV_SEED: 'true', DEV_SEED_PASSWORD: 'a-different-one' });
    expect(custom.allowed === true && custom.password).toBe('a-different-one');
  });

  it('rejects a blank DEV_SEED_PASSWORD rather than silently seeding the default', () => {
    // Silently falling back would mint `correct-password` on a box whose operator believed they had
    // overridden it — the failure mode is invisible until someone tries the well-known password.
    const cfg = readDevSeedConfig({ ALLOW_DEV_SEED: 'true', DEV_SEED_PASSWORD: '   ' });
    expect(cfg.allowed).toBe(false);
    expect(cfg.allowed === false && cfg.reason).toContain('DEV_SEED_PASSWORD');
  });
});

/**
 * The ordering precondition, as a pure predicate. `seedAuthFixtureUsers` resolves each ZM's zone by
 * NAME against an already-seeded `zones` table; if org reference data has not been seeded, the upsert
 * still succeeds and quietly writes a ZONAL_MANAGER with a null `zone_id`. That account then logs in
 * and every zone-scoped route 403s — a working login that cannot do anything, which is a worse
 * outcome to debug than the 401 #194 exists to fix. So the sequence documented in `.env.example`
 * (migrate → seed → seed:dev) is enforced, not merely written down.
 */
describe('#194 dev-seed zone preflight — missingDevSeedZones', () => {
  it('is satisfied by the operational zones the fixture ZMs are scoped to', () => {
    expect(missingDevSeedZones(['North', 'South', 'East', 'West', 'UNZONED'])).toEqual([]);
  });

  it('names exactly the zones that are absent, so the error can say what to run', () => {
    expect(missingDevSeedZones(['North', 'South'])).toEqual(['East', 'West']);
    expect(missingDevSeedZones([])).toEqual(['North', 'South', 'East', 'West']);
  });

  it('does not require UNZONED — no fixture user is scoped to the holding zone', () => {
    expect(missingDevSeedZones(['North', 'South', 'East', 'West'])).toEqual([]);
  });
});
