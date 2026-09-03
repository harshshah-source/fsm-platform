/** Roles that can act in a Zonal Manager's scope via the backup cascade (CONTEXT.md §15). */
export const ACTING_CAPABLE_ROLES = new Set(['CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD']);

export interface ActingContext {
  /** The caller's real role. */
  actorRole: string;
  /** Set when the caller is acting in another (ZM) scope; null for normal requests. */
  actedAsRole: string | null;
  /** The zone being acted in, when acting; otherwise null. */
  actingZone: number | null;
}

/**
 * The acting context of a request that is not acting — a caller's own role, nothing proxied.
 *
 * #339 moved the *resolution* into `common/guards/acting-context.guard.ts`, which is the only place
 * that reads the `X-Acting-As-Zone` header. It must be: the check the header now passes is async (the
 * zone must exist, and the CSM must actually hold that zone's ZM duty per `role_unavailability`),
 * while the two consumers — `@CurrentScope` and `@CurrentActor` — are synchronous param decorators.
 * They read `request.acting`, and fall back to this when there is none.
 *
 * **The fallback is deliberately the non-acting context, never a re-parse.** Re-deriving acting from
 * the header here would hand back exactly the ungated grant #339 exists to remove, from a code path
 * that looks like a safety net.
 */
export function notActing(role: string): ActingContext {
  return { actorRole: role, actedAsRole: null, actingZone: null };
}
