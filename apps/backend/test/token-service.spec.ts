import { TokenService } from '../src/auth/token.service';
import { DEV_DEFAULT_JWT_SECRET } from '../src/config/boot-config';

/**
 * TokenService secret sourcing (#98 leg 2). The old `?? 'dev-...'` fallback let a process with no
 * JWT_ACCESS_SECRET silently sign tokens with a repo-published constant — forgeable by anyone. The
 * secret must now come only from the environment (boot validation guarantees it is present + safe).
 */
describe('TokenService secret sourcing (#98)', () => {
  const original = process.env.JWT_ACCESS_SECRET;
  afterEach(() => {
    process.env.JWT_ACCESS_SECRET = original;
  });

  it('signs and verifies a round-trip with the env secret', () => {
    process.env.JWT_ACCESS_SECRET = 'a'.repeat(40);
    const svc = new TokenService();
    const token = svc.signAccessToken({ user_id: 'u1', role: 'OPERATIONS_HEAD', zone_id: null });
    expect(svc.verifyAccessToken(token)).toMatchObject({ user_id: 'u1', role: 'OPERATIONS_HEAD' });
  });

  it('throws rather than falling back to the published dev default when the secret is unset', () => {
    delete process.env.JWT_ACCESS_SECRET;
    expect(() => new TokenService()).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('does not accept a token forged with the old published dev default secret', () => {
    process.env.JWT_ACCESS_SECRET = 'b'.repeat(40);
    const svc = new TokenService();
    // Forge a token signed with the old published constant.
    process.env.JWT_ACCESS_SECRET = DEV_DEFAULT_JWT_SECRET;
    const forged = new TokenService().signAccessToken({ user_id: 'attacker', role: 'OPERATIONS_HEAD', zone_id: null });
    process.env.JWT_ACCESS_SECRET = 'b'.repeat(40);
    expect(() => svc.verifyAccessToken(forged)).toThrow();
  });
});
