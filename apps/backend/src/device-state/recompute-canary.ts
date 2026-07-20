/**
 * #130 L5 — semantic canary decision. A large relative swing in the eligible count between two
 * consecutive recomputes is the fingerprint of semantic corruption from ANY cause — stale code,
 * env mismatch, a wrong DATABASE_URL — that no version check can see. It WARNS, never blocks:
 * legitimate mass events (#119 deactivations, the #128 backfill) also swing hard, and hard-failing
 * true corruption is L2's job (the recompute invariant).
 */
export interface CanaryVerdict {
  /** True when |relative change| strictly exceeds the threshold. */
  breached: boolean;
  /** Signed relative change, as a percentage (positive = rise, negative = drop). */
  deltaPct: number;
}

/**
 * Compare the current eligible count against the previous baseline. Returns `null` (skip) when there
 * is no usable baseline — the first recompute, or a previous count of 0 (no defined relative change).
 */
export function evaluateRecomputeCanary(
  previousEligible: number | null | undefined,
  currentEligible: number,
  thresholdPct: number,
): CanaryVerdict | null {
  if (previousEligible == null || previousEligible === 0) return null;
  const deltaPct = ((currentEligible - previousEligible) / previousEligible) * 100;
  return { breached: Math.abs(deltaPct) > thresholdPct, deltaPct };
}
