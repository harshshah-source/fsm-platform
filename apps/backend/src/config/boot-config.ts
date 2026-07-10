/**
 * Fail-fast boot configuration (#98 legs 1+2). A pure validator, called before `app.listen()`, that
 * refuses to start the process when required config is missing or unsafe — so a misconfigured deploy
 * fails loudly at boot instead of silently signing forgeable tokens or connecting nowhere.
 *
 * Kept dependency-free (no zod/joi) in keeping with the auth slice's zero-registry stance.
 */

/** The old repo-published dev secret that `TokenService` used to fall back to. Must never be accepted. */
export const DEV_DEFAULT_JWT_SECRET = 'dev-access-secret-change-me';

/** Minimum entropy floor for the HS256 signing secret. */
export const MIN_JWT_SECRET_LENGTH = 32;

export interface BootConfig {
  jwtAccessSecret: string;
  databaseUrl: string;
}

/**
 * Validates the process environment and returns the safe, typed config, or throws with a clear,
 * actionable message on the first problem. Always fatal (throwing) — there is no lenient mode: a weak
 * or missing secret is a security defect in every environment, so dev/test/CI must supply a real one.
 */
export function validateBootConfig(env: NodeJS.ProcessEnv = process.env): BootConfig {
  const secret = env.JWT_ACCESS_SECRET;
  if (!secret) {
    throw new Error('Boot config: JWT_ACCESS_SECRET is not set. Set a random secret of at least 32 chars.');
  }
  if (secret === DEV_DEFAULT_JWT_SECRET) {
    throw new Error(
      'Boot config: JWT_ACCESS_SECRET is still the published dev default. Set a unique random secret.',
    );
  }
  if (secret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(
      `Boot config: JWT_ACCESS_SECRET is too short (${secret.length} chars). Use at least ${MIN_JWT_SECRET_LENGTH}.`,
    );
  }

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('Boot config: DATABASE_URL is not set.');
  }
  if (!isParseablePostgresUrl(databaseUrl)) {
    throw new Error('Boot config: DATABASE_URL is not a parseable postgres connection URL.');
  }

  return { jwtAccessSecret: secret, databaseUrl };
}

function isParseablePostgresUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'postgres:' || url.protocol === 'postgresql:';
  } catch {
    return false;
  }
}
