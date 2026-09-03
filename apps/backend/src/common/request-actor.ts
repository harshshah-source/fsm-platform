import type { ActingContext } from '../auth/acting-context';
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
  /**
   * The caller's **own** zone from their claims — not the zone they are acting in. The two are
   * genuinely different questions and both are asked: `actingZone` is attribution ("which zone's ZM
   * duty is this write being made under"), `zoneId` is the caller's home scope, which several write
   * doors still use to decide what they may touch.
   *
   * #340 carries it here so a controller can hand one object to an audited service instead of
   * hand-building a near-copy — which is how the `actedAsRole: null` literal spread to eleven doors
   * in the first place. It is the claims value **verbatim**: whether acting should *narrow* a write
   * door's scope is #341's question, and answering it here would change permissions under cover of
   * an attribution fix.
   */
  zoneId: number | null;
}

/** Resolve the request's actor from verified claims + the acting context `ActingContextGuard` proved
 *  for this request (#339). */
export function resolveRequestActor(user: AccessTokenClaims, acting: ActingContext): RequestActor {
  return {
    userId: user.user_id,
    role: acting.actorRole,
    actedAsRole: acting.actedAsRole,
    actingZone: acting.actingZone,
    zoneId: user.zone_id,
  };
}
