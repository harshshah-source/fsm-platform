import {
  hashDummyPassword,
  hashPassword,
  verifyPassword,
} from '../src/auth/password-hasher';

/**
 * Issue #91 S2 — unit coverage for the async scrypt helper that replaces `user-store.ts`'s
 * `scryptSync`. `PrismaUserStore` is covered end-to-end by `db-backed-login.e2e-spec.ts`; this file
 * pins the hashing primitives themselves.
 */
describe('password-hasher (#91)', () => {
  it('round-trips: a hash verifies against the password that produced it', async () => {
    const { hash, salt } = await hashPassword('correct-password');
    expect(await verifyPassword('correct-password', hash, salt)).toBe(true);
  });

  it('rejects a wrong password against a real hash', async () => {
    const { hash, salt } = await hashPassword('correct-password');
    expect(await verifyPassword('wrong-password', hash, salt)).toBe(false);
  });

  it('two hashes of the same password use different salts (and thus different hashes)', async () => {
    const a = await hashPassword('correct-password');
    const b = await hashPassword('correct-password');
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });

  // #91 2026-07-28 amendment 1: an unknown email still runs a real scrypt derivation (hashDummyPassword)
  // rather than short-circuiting, so `validateCredentials` costs roughly the same wall-clock time
  // whether the email exists or not. Assert it actually performs comparable, non-trivial work rather
  // than resolving near-instantly (which is what a short-circuited "no such user" path would do).
  it('hashDummyPassword performs a real (non-trivial) derivation, not a short-circuit', async () => {
    const start = process.hrtime.bigint();
    await hashDummyPassword('whatever-the-caller-typed');
    const dummyMs = Number(process.hrtime.bigint() - start) / 1e6;

    const start2 = process.hrtime.bigint();
    await hashPassword('whatever-the-caller-typed');
    const realMs = Number(process.hrtime.bigint() - start2) / 1e6;

    // Both are real scrypt derivations at the same cost params, so they should be the same order of
    // magnitude. A short-circuited dummy path would be >10x faster than a real hash; a generous 3x
    // floor catches that regression without being a flaky microsecond-level timing assertion.
    expect(dummyMs).toBeGreaterThan(realMs / 3);
  });
});
