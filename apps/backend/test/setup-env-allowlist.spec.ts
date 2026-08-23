import { sanitizeTestEnv } from './setup-env';

/**
 * #182 AC-1 / AC-5 — the allowlist boundary itself. `sanitizeTestEnv` already ran once for real as a
 * vitest `setupFile` before this spec's module even loaded; re-invoking it here against a synthetic
 * env object proves the boundary is what it claims to be, independent of whatever happens to be in
 * this process's actual `process.env` right now.
 */
describe('setup-env allowlist (#182)', () => {
  const baseEnv = (): NodeJS.ProcessEnv => ({
    DATABASE_URL: 'postgresql://fsm:pw@localhost:5433/fsm?schema=public',
  });

  it('deletes a NEW app-namespace key nobody named explicitly — the class is closed, not the instance', () => {
    const env = baseEnv();
    // A flag that does not exist today and is not named anywhere in sanitizeTestEnv — only its
    // prefix family is. If this survives, the allowlist has regressed into a deny-list.
    env.BUSINESS_SWEEP_FUTURE_FLAG = 'true';
    env.INGESTION_SOME_NEW_TOGGLE = 'true';
    env.PARTITION_ANOTHER_NEW_KNOB = '99';

    sanitizeTestEnv(env);

    expect(env.BUSINESS_SWEEP_FUTURE_FLAG).toBeUndefined();
    expect(env.INGESTION_SOME_NEW_TOGGLE).toBeUndefined();
    expect(env.PARTITION_ANOTHER_NEW_KNOB).toBeUndefined();
  });

  it('deletes every documented app-namespace literal and prefix family', () => {
    const env = baseEnv();
    env.TEST_DATABASE_URL = 'postgresql://fsm:pw@localhost:5433/somewhere_else';
    env.ADMIN_ORIGIN = 'https://not-localhost.example';
    env.PORT = '9999';
    env.DEV_AUTH_ZONE = 'EAST';
    env.AUTOPLANT_MYSQL_HOST = 'prod-mysql.example';
    env.AUTO_RECOVERY_MAX_PER_PASS = 'unlimited';
    env.COMMISSIONING_TTFR_EPOCH = '2020-01-01T00:00:00.000Z';
    env.DB_POOL_MAX = '1000';
    env.PLANT_ELIGIBILITY_REFRESH_CRON = '* * * * *';
    env.DISPATCH_STALE_RUN_MIN = '120';
    env.DISPATCH_RETRY_DEADLINE_MS = '900000';
    env.ALLOW_DEV_SEED = 'true';
    env.DEV_SEED_PASSWORD = 'something-the-developer-chose';

    sanitizeTestEnv(env);

    expect(env.TEST_DATABASE_URL).toBeUndefined();
    expect(env.ADMIN_ORIGIN).toBeUndefined();
    expect(env.PORT).toBeUndefined();
    expect(env.DEV_AUTH_ZONE).toBeUndefined();
    expect(env.AUTOPLANT_MYSQL_HOST).toBeUndefined();
    // #229 — an uncapped auto-recovery pass leaking in from a developer's .env would turn the
    // suite's bounded fixtures into a full-table drain.
    expect(env.AUTO_RECOVERY_MAX_PER_PASS).toBeUndefined();
    // #232 — the TTFR epoch decides which fitments contribute a timing sample at all. A developer's
    // re-baselined epoch reaching the suite would silently change every median the specs assert.
    expect(env.COMMISSIONING_TTFR_EPOCH).toBeUndefined();
    expect(env.DB_POOL_MAX).toBeUndefined();
    expect(env.PLANT_ELIGIBILITY_REFRESH_CRON).toBeUndefined();
    // #261/#260 — both are load-bearing for suite outcomes, not just for production. A developer's
    // raised `DISPATCH_STALE_RUN_MIN` makes the reaper specs' hour-old fixtures no longer stale, and a
    // leaked `DISPATCH_RETRY_DEADLINE_MS` makes every contended-zone assertion wait minutes for an
    // answer it expects immediately.
    expect(env.DISPATCH_STALE_RUN_MIN).toBeUndefined();
    expect(env.DISPATCH_RETRY_DEADLINE_MS).toBeUndefined();
    // #194 — a developer who has opted their own box into the dev-login seeder must not thereby
    // change what the suite does. `dev-seed.spec.ts` passes env in explicitly for the same reason.
    expect(env.ALLOW_DEV_SEED).toBeUndefined();
    expect(env.DEV_SEED_PASSWORD).toBeUndefined();
  });

  it('sets the R1.a fixed test values regardless of what the ambient env held', () => {
    const env = baseEnv();
    env.BUSINESS_SWEEPS_ENABLED = 'true';
    env.INGESTION_SCHEDULER_ENABLED = 'true';
    env.PARTITION_MAINTENANCE_ENABLED = 'true';
    env.JWT_ACCESS_SECRET = 'whatever-the-developer-had-locally';

    sanitizeTestEnv(env);

    expect(env.BUSINESS_SWEEPS_ENABLED).toBe('false');
    expect(env.INGESTION_SCHEDULER_ENABLED).toBe('false');
    expect(env.PARTITION_MAINTENANCE_ENABLED).toBe('false');
    expect(env.JWT_ACCESS_SECRET).toBe('test-jwt-access-secret-000000000000000000');
    expect(env.DATABASE_URL).toMatch(/_test(\?|$)/);
  });

  it('neutralises PG* and pins TZ to UTC — the two named exceptions outside the app namespace', () => {
    const env = baseEnv();
    env.PGDATABASE = 'someone_elses_db';
    env.PGHOST = 'not-localhost';
    env.TZ = 'Asia/Kolkata';

    sanitizeTestEnv(env);

    expect(env.PGDATABASE).toBeUndefined();
    expect(env.PGHOST).toBeUndefined();
    expect(env.TZ).toBe('UTC');
  });

  it('#182 AC-5 — never touches a key outside the app namespace', () => {
    const env = baseEnv();
    env.PATH = '/usr/bin:/bin';
    env.NODE_ENV = 'test';
    env.CI = 'true';
    env.TEMP = 'C:\\Temp';
    env.USER = 'harsh';
    env.BOOK8_RUN = '1';
    env.BOOK_DATASET = 'book8-mumbai';

    sanitizeTestEnv(env);

    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.NODE_ENV).toBe('test');
    expect(env.CI).toBe('true');
    expect(env.TEMP).toBe('C:\\Temp');
    expect(env.USER).toBe('harsh');
    expect(env.BOOK8_RUN).toBe('1');
    expect(env.BOOK_DATASET).toBe('book8-mumbai');
  });
});
