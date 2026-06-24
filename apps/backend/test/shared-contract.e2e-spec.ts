import { ROLES, isRole } from '@fsm/shared';
import type { LoginRequest, LoginResponse, SessionView } from '@fsm/shared';

/**
 * @fsm/shared is the single source of truth for the auth/session contract consumed by
 * both the backend and the admin app. This proves the backend resolves the package and
 * that the runtime (ROLES/isRole) and the DTO shapes match the API.
 */
describe('@fsm/shared — auth/session contract', () => {
  it('exposes the five canonical roles', () => {
    expect(ROLES).toEqual([
      'SERVICE_ENGINEER',
      'ZONAL_MANAGER',
      'CENTRAL_SERVICE_MANAGER',
      'OPERATIONS_HEAD',
      'WAREHOUSE_MANAGER',
    ]);
  });

  it('isRole accepts canonical roles and rejects anything else (no ADMIN)', () => {
    expect(isRole('ZONAL_MANAGER')).toBe(true);
    expect(isRole('ADMIN')).toBe(false);
  });

  it('session/login DTOs match the API contract', () => {
    const login: LoginRequest = { email: 'a@b.c', password: 'x' };
    const tokens: LoginResponse = { accessToken: 'a', refreshToken: 'r' };
    const session: SessionView = {
      user_id: 'u',
      role: 'OPERATIONS_HEAD',
      zone_id: null,
      acted_as_role: null,
    };
    expect(login.email).toBe('a@b.c');
    expect(tokens.accessToken).toBe('a');
    expect(session.role).toBe('OPERATIONS_HEAD');
  });
});
