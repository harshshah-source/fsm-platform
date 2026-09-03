import { describe, expect, it } from 'vitest';
import { notActing } from '../src/auth/acting-context';
import type { AccessTokenClaims } from '../src/auth/token.service';
import { resolveManagerScope } from '../src/common/manager-scope';

/**
 * Issue 27 — the read scope of a manager surface, acting context included. `resolveActingContext`
 * already resolved acting for *audit attribution*; this resolves it for *what data comes back*, which
 * every `/api/dashboard/*` read ignored: acting swapped the dashboard body but not one row behind it.
 *
 * **Rewritten for #339's contract.** This function used to take the raw `X-Acting-As-Zone` header and
 * do everything itself — parse it, decide which roles may act, and decide what to do with nonsense.
 * It now takes an `ActingContext` that `ActingContextGuard` has already **proven**, and decides
 * nothing about permission: it reads a decision that has been made.
 *
 * So three cases this file used to own have moved, and are asserted where the decision now lives, in
 * `acting-context.e2e-spec.ts` against a real request:
 *
 * - *"a ZM's header is ignored"* — the guard never puts an acting zone on a request from a role that
 *   cannot act, so there is no such context to hand this function.
 * - *"a non-numeric header does not widen to pan-India"* — now a **400 `ACTING_ZONE_INVALID`**; the
 *   request never reaches a handler, which is a stronger guarantee than the old "resolves to the
 *   caller's own scope".
 * - *"an unknown zone is refused"* — likewise a 400, and for a CSM an unpermitted zone is a 403.
 *
 * Re-asserting them here would mean feeding this function a context the guard cannot produce, and
 * would quietly re-document a gate that no longer lives in this file.
 */
const oh: AccessTokenClaims = { user_id: 'oh1', role: 'OPERATIONS_HEAD', zone_id: null };
const csm: AccessTokenClaims = { user_id: 'csm1', role: 'CENTRAL_SERVICE_MANAGER', zone_id: null };
const zm: AccessTokenClaims = { user_id: 'zm1', role: 'ZONAL_MANAGER', zone_id: 1 };

/** What the guard puts on a request whose caller is acting in `zoneId` — the only shape it produces. */
const acting = (user: AccessTokenClaims, zoneId: number) => ({
  actorRole: user.role,
  actedAsRole: user.role,
  actingZone: zoneId,
});

describe('resolveManagerScope', () => {
  it('is the caller’s own claims when the request is not acting', () => {
    expect(resolveManagerScope(oh, notActing(oh.role))).toEqual({ role: 'OPERATIONS_HEAD', zoneId: null });
    expect(resolveManagerScope(zm, notActing(zm.role))).toEqual({ role: 'ZONAL_MANAGER', zoneId: 1 });
  });

  it('collapses an acting Operations Head to the target zone’s ZM scope', () => {
    expect(resolveManagerScope(oh, acting(oh, 4))).toEqual({ role: 'ZONAL_MANAGER', zoneId: 4 });
  });

  it('collapses an acting CSM the same way', () => {
    expect(resolveManagerScope(csm, acting(csm, 2))).toEqual({ role: 'ZONAL_MANAGER', zoneId: 2 });
  });

  it('reads the proven zone and never the caller’s own — a ZM’s claims do not leak into an acting scope', () => {
    // The one case where the two could disagree: the caller has a home zone *and* an acting zone. The
    // acting zone wins, because that is the decision the guard made; falling back to the claims here
    // would silently serve a different zone's rows than the banner names.
    const zmWithHomeZone: AccessTokenClaims = { user_id: 'x', role: 'CENTRAL_SERVICE_MANAGER', zone_id: 1 };
    expect(resolveManagerScope(zmWithHomeZone, acting(zmWithHomeZone, 7))).toEqual({
      role: 'ZONAL_MANAGER',
      zoneId: 7,
    });
  });
});
