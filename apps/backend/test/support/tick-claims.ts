import type { TickClaimPruner, TickClaimant } from '../../src/scheduling/cron-tick-claim';

/**
 * #263 — the two-line stand-ins a spec uses when it is testing something other than tick arbitration.
 *
 * Every scheduler now takes a {@link TickClaimant}, and most specs that construct one care about
 * dormancy, cadence or the sweep itself — not about which instance owns the window. Handing those a
 * connection pool would be worse than noise: `CronTickClaimService` writes rows, so a spec driving the
 * same handler ten times would start refusing itself the moment two calls landed in one minute.
 *
 * The real arbitration is pinned in `cron-tick-claim-wiring.e2e-spec.ts`, over two live pools.
 */

/** Grants every window — "assume this instance is the only one", the pre-#263 world. */
export const alwaysClaims = (): TickClaimant & TickClaimPruner => ({
  claimTickOrLog: async () => true,
  pruneExpiredClaims: async () => 0,
});

/** Refuses every window — for asserting a scheduler's behaviour when another instance holds the tick. */
export const neverClaims = (): TickClaimant & TickClaimPruner => ({
  claimTickOrLog: async () => false,
  pruneExpiredClaims: async () => 0,
});
