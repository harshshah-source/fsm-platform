import { validateBootConfig, DEV_DEFAULT_JWT_SECRET } from '../src/config/boot-config';

/**
 * Boot config validation (#98 leg 1+2). A pure fail-fast validator: a process must not start — and
 * TokenService must not sign with a forgeable secret — when JWT_ACCESS_SECRET is unset, still the
 * published dev default, or too short, or when DATABASE_URL is missing/unparseable.
 */
const STRONG_SECRET = 'x'.repeat(32);
const OK_DB = 'postgresql://u:p@localhost:5432/fsm';

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { JWT_ACCESS_SECRET: STRONG_SECRET, DATABASE_URL: OK_DB, ...overrides };
}

describe('validateBootConfig (#98 fail-fast boot)', () => {
  it('returns the validated config when everything is present and safe', () => {
    const cfg = validateBootConfig(env());
    expect(cfg.jwtAccessSecret).toBe(STRONG_SECRET);
    expect(cfg.databaseUrl).toBe(OK_DB);
  });

  it('throws when JWT_ACCESS_SECRET is unset', () => {
    expect(() => validateBootConfig(env({ JWT_ACCESS_SECRET: undefined }))).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('throws when JWT_ACCESS_SECRET is still the published dev default', () => {
    expect(() => validateBootConfig(env({ JWT_ACCESS_SECRET: DEV_DEFAULT_JWT_SECRET }))).toThrow(
      /JWT_ACCESS_SECRET/,
    );
  });

  it('throws when JWT_ACCESS_SECRET is shorter than 32 chars', () => {
    expect(() => validateBootConfig(env({ JWT_ACCESS_SECRET: 'x'.repeat(31) }))).toThrow(/32/);
  });

  it('throws when DATABASE_URL is unset', () => {
    expect(() => validateBootConfig(env({ DATABASE_URL: undefined }))).toThrow(/DATABASE_URL/);
  });

  it('throws when DATABASE_URL is not a parseable postgres URL', () => {
    expect(() => validateBootConfig(env({ DATABASE_URL: 'not-a-url' }))).toThrow(/DATABASE_URL/);
  });
});
