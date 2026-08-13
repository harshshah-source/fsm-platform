/**
 * Dev-login seed — the guard (#194).
 *
 * #91 S4 retired `InMemoryUserStore`, which used to seed five `*@fsm.test` users at process boot; the
 * accounts survived only by moving into the **test-only** fixture (`auth-fixture-seed.ts`), whose
 * single caller is `test/global-setup.ts` against `fsm_test`. The implicit dev-login provision was
 * removed without a replacement, so on a clean clone every login 401s. #194 builds the replacement.
 *
 * The fixture's walling-off from `src/seed.ts` is correct and stays: a `pnpm seed` against a real
 * database must never be able to mint `*@fsm.test` credentials. What this adds is the *other half* —
 * a separate, explicitly-gated dev entrypoint — so the wall is opened by a door with a lock on it,
 * not knocked through. A credential minter with a well-known password that can be pointed at
 * production would be a worse defect than the one #194 fixes, so the refusal is the contract:
 *
 *  - `ALLOW_DEV_SEED` — **default off, in every environment**, following #217's `OPS_EXPLORER_ENABLED`
 *    precedent. Nothing runs without an operator typing it. Unset is the safe value, and unset is what
 *    every deployed environment has.
 *  - `NODE_ENV=production` — an **unconditional** refusal that the opt-in cannot override. The two
 *    layers are deliberately not symmetric: the flag exists to be set on a dev box, so a copied `.env`
 *    carrying it must still be refused where it matters most.
 *
 * Residual risk, stated rather than hidden: a staging/production box with `NODE_ENV` unset *and*
 * `ALLOW_DEV_SEED` set would pass both layers. A third, data-derived layer was considered — refusing
 * when the target database already holds credentials for non-`@fsm.test` users — and rejected: the
 * dev database is an ingested mirror that legitimately looks like production, and a developer who
 * creates one real-email login through the admin UI would then be locked out of the seeder with no
 * override short of a third flag. The two env layers are what #194's AC asks for; the accounts minted
 * are confined to the reserved `.test` TLD, and `ensureCredential` never rotates an existing hash.
 *
 * A pure function of an `env` object (not `process.env`), matching `ops-explorer.config.ts` and
 * `boot-config.ts`: directly unit-testable, and callers pass env explicitly so `test/setup-env.ts`'s
 * allowlist scrub can never change what the seeder does under test.
 */

/**
 * The password the fixture users have carried since they lived in `InMemoryUserStore`. Kept as the
 * default deliberately — `apps/admin/visual/manifest.mjs` `CREDS` hardcodes it, and #194 AC-4 asks
 * that `npm run visual:capture` work on a clean machine without a second piece of configuration.
 * Well-known is acceptable precisely because the guard above is what keeps these accounts off any
 * database that matters.
 */
export const DEV_SEED_DEFAULT_PASSWORD = 'correct-password';

export type DevSeedConfig =
  | { allowed: true; password: string }
  | { allowed: false; reason: string };

/** Env values accepted as true — the same vocabulary `ops-explorer.config.ts` established. */
function isAffirmative(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

export function readDevSeedConfig(env: NodeJS.ProcessEnv = process.env): DevSeedConfig {
  if ((env.NODE_ENV ?? '').trim().toLowerCase() === 'production') {
    return {
      allowed: false,
      reason:
        'Refusing to seed dev logins: NODE_ENV=production. This seeder mints manager-role accounts ' +
        'with a well-known password and is for development databases only; ALLOW_DEV_SEED does not ' +
        'override this. Use POST /api/org/users to provision real accounts.',
    };
  }

  if (!isAffirmative(env.ALLOW_DEV_SEED)) {
    return {
      allowed: false,
      reason:
        'Refusing to seed dev logins: ALLOW_DEV_SEED is not set. This is opt-in per machine because ' +
        'it creates *@fsm.test accounts with a well-known password. Set ALLOW_DEV_SEED=true in ' +
        'apps/backend/.env once you have confirmed DATABASE_URL points at your development database.',
    };
  }

  const override = env.DEV_SEED_PASSWORD;
  if (override !== undefined && override.trim() === '') {
    return {
      allowed: false,
      reason:
        'Refusing to seed dev logins: DEV_SEED_PASSWORD is set but blank. Falling back to the default ' +
        'here would mint the well-known password on a machine whose operator believed they had ' +
        'replaced it. Give it a value or remove it.',
    };
  }

  return { allowed: true, password: override ?? DEV_SEED_DEFAULT_PASSWORD };
}
