import { resolveActingContext } from '../auth/acting-context';
import type { AccessTokenClaims } from '../auth/token.service';

/**
 * The fully-resolved acting identity for a request: the caller's real role plus, when they are
 * acting in a Zonal Manager's zone via `X-Acting-As-Zone`, the proxied `actedAsRole` and the
 * `actingZone`. This is the shape controllers hand to audited services — unlike
 * `AccessTokenClaims` it can carry attribution, so `acted_as_role` reaches the `audit_logs`
 * row instead of being structurally null (Issue 47).
 */
export interface RequestActor {
  userId: string;
  role: string;
  actedAsRole: string | null;
  actingZone: number | null;
}

/** Resolve the request's actor from verified claims + the optional acting-zone header. */
export function resolveRequestActor(
  user: AccessTokenClaims,
  actingZoneHeader: string | undefined,
): RequestActor {
  const acting = resolveActingContext(user, actingZoneHeader);
  return {
    userId: user.user_id,
    role: acting.actorRole,
    actedAsRole: acting.actedAsRole,
    actingZone: acting.actingZone,
  };
}
