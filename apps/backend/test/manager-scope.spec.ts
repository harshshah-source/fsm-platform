import { describe, expect, it } from 'vitest';
import type { AccessTokenClaims } from '../src/auth/token.service';
import { resolveManagerScope } from '../src/common/manager-scope';

/**
 * Issue 27 — the read scope of a manager surface, acting context included. `resolveActingContext`
 * already resolved acting for *audit attribution*; this resolves it for *what data comes back*, which
 * every `/api/dashboard/*` read ignored: acting swapped the dashboard body but not one row behind it.
 */
const oh: AccessTokenClaims = { user_id: 'oh1', role: 'OPERATIONS_HEAD', zone_id: null };
const csm: AccessTokenClaims = { user_id: 'csm1', role: 'CENTRAL_SERVICE_MANAGER', zone_id: null };
const zm: AccessTokenClaims = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1 };

describe('resolveManagerScope', () => {
  it('is the caller’s own claims when no acting header is present', () => {
    expect(resolveManagerScope(oh, undefined)).toEqual({ role: 'OPERATIONS_HEAD', zoneId: null });
    expect(resolveManagerScope(zm, undefined)).toEqual({ role: 'ZONAL_MANAGER', zoneId: 1 });
  });

  it('collapses an acting Operations Head to the target zone’s ZM scope', () => {
    expect(resolveManagerScope(oh, '4')).toEqual({ role: 'ZONAL_MANAGER', zoneId: 4 });
  });

  it('collapses an acting CSM the same way', () => {
    expect(resolveManagerScope(csm, '2')).toEqual({ role: 'ZONAL_MANAGER', zoneId: 2 });
  });

  it('ignores the header for a role that cannot act — a ZM stays clamped to their own zone', () => {
    expect(resolveManagerScope(zm, '9')).toEqual({ role: 'ZONAL_MANAGER', zoneId: 1 });
  });

  it('ignores a non-numeric or empty header rather than widening or clamping to NaN', () => {
    expect(resolveManagerScope(oh, 'north')).toEqual({ role: 'OPERATIONS_HEAD', zoneId: null });
    expect(resolveManagerScope(oh, '')).toEqual({ role: 'OPERATIONS_HEAD', zoneId: null });
  });
});
