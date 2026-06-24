import { AccessTokenClaims } from './token.service';

/** Roles that can act in a Zonal Manager's scope via the backup cascade (CONTEXT.md §15). */
const ACTING_CAPABLE_ROLES = new Set(['CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD']);

export interface ActingContext {
  /** The caller's real role. */
  actorRole: string;
  /** Set when the caller is acting in another (ZM) scope; null for normal requests. */
  actedAsRole: string | null;
  /** The zone being acted in, when acting; otherwise null. */
  actingZone: number | null;
}

/**
 * Resolves whether the caller is acting in a Zonal Manager's scope. A CSM or Operations
 * Head that targets a zone (via the `X-Acting-As-Zone` header) is acting on that ZM's
 * behalf, so `acted_as_role` is stamped with their own role for the audit trail.
 *
 * NOTE: this is the request-context proxy verified at the claims layer. The backup-cascade
 * *authorization* (who may act when, driven by ROLE_UNAVAILABILITY) and the persisting of
 * `acted_as_role` onto audit rows land with the DB slices (TB6+).
 */
export function resolveActingContext(
  user: AccessTokenClaims,
  actingZoneHeader: string | undefined,
): ActingContext {
  const zone = parseZone(actingZoneHeader);
  if (zone !== null && ACTING_CAPABLE_ROLES.has(user.role)) {
    return { actorRole: user.role, actedAsRole: user.role, actingZone: zone };
  }
  return { actorRole: user.role, actedAsRole: null, actingZone: null };
}

function parseZone(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw);
  return Number.isNaN(value) ? null : value;
}
