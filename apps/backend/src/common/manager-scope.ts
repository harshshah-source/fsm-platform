import type { ActingContext } from '../auth/acting-context';
import type { AccessTokenClaims } from '../auth/token.service';

/**
 * The `{ role, zoneId }` pair every manager read service filters on: a ZONAL_MANAGER is clamped to
 * `zoneId`, a CSM / Operations Head sees every zone.
 */
export interface ManagerScope {
  role: string;
  zoneId: number | null;
}

/**
 * Resolve a manager read's scope from the verified claims **plus the acting context**.
 *
 * A CSM / Operations Head acting in a zone (`X-Acting-As-Zone`) reads **as that zone's ZM** — the same
 * collapse the admin UI already makes when acting swaps the pan-India dashboard for the Zone Operations
 * view (FE-07). Before this, controllers built the scope straight from the claims, so acting changed
 * which dashboard rendered but not one row of the data behind it: the "zone" view showed pan-India
 * numbers. Reads only — audit attribution stays with {@link RequestActor}, which keeps the caller's
 * real role and stamps `acted_as_role`.
 *
 * With no acting context this is exactly the old expression, so a ZM stays clamped to their own zone
 * and a non-acting CSM / OH stays pan-India. A ZM cannot widen: `ActingContextGuard` (#339) only ever
 * sets an acting zone for the two acting-capable roles, and only once the cascade allows it — this
 * function no longer decides anything about permission, it only reads the decision.
 */
export function resolveManagerScope(user: AccessTokenClaims, acting: ActingContext): ManagerScope {
  if (acting.actingZone !== null) {
    return { role: 'ZONAL_MANAGER', zoneId: acting.actingZone };
  }
  return { role: user.role, zoneId: user.zone_id };
}
