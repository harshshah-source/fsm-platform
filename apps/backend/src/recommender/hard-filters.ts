/**
 * Recommender Hard Filters (ADR-0003 layer 1, LLD §13.1). Pure: given each candidate SE's readiness,
 * drop the ineligible ones BEFORE scoring. The readiness shape is the seam — fields whose source
 * tables are owned by later issues (vehicle readiness → 28, availability → 25/26, van stock → 21) are
 * supplied by an injected provider that currently defaults them to "pass"; the drop logic here is
 * real and fully tested. `STALE`/`UNKNOWN` vehicle readiness is deliberately NOT a drop — it is a ZM
 * conflict signal surfaced elsewhere.
 *
 * **SE activity-ping staleness is deliberately NOT a Hard Filter.** `last_activity_at` is
 * visibility/audit only and never removes a candidate (CONTEXT.md Decisions §3 & §16, revised
 * 2026-06-09 — supersedes the ADR-0016/0024 "15-min intra-day heartbeat filter"). An SE working
 * offline or in a no-network field area must stay a candidate; intra-day unreachability is resolved by
 * the Acceptance Timeout + reroute (Issue 29/30), not by dropping the candidate here.
 */

export type VehicleReadiness = 'READY' | 'ON_TRIP' | 'STALE' | 'UNKNOWN';

export interface SeCandidateReadiness {
  seId: string;
  vehicleReadiness: VehicleReadiness;
  /** #270 — false while Issue 28's feed is unbuilt: VEHICLE_ON_TRIP is reported NOT_ENFORCED rather
   *  than a fabricated PASSED, and can never drop. The feed site (`candidate-readiness.ts`) sets this;
   *  wiring real data flips it to true there, with no change to this file. */
  vehicleReadinessEnforced: boolean;
  available: boolean;
  overCapacity: boolean;
  commonKitComplete: boolean;
  expectedComponentsAvailable: boolean;
  /** #270 — same seam as {@link vehicleReadinessEnforced}, for Issue 22's feed. */
  componentAvailabilityEnforced: boolean;
}

export type HardFilterReason =
  | 'VEHICLE_ON_TRIP'
  | 'SE_UNAVAILABLE'
  | 'OVER_CAPACITY'
  | 'COMMON_KIT_INCOMPLETE'
  | 'COMPONENT_UNAVAILABLE';

/** #270 — the honesty vocabulary shared by every non-blocking Phase-1 seam: a filter/feature is either
 *  evaluated for real (PASSED/FAILED) or its data source does not exist yet (NOT_ENFORCED), and the
 *  UI/trace must never render the latter as a pass. #267's `distanceScore` reuses the same
 *  "no fabricated 0/false default" convention under its own `NOT_AVAILABLE` sentinel — a per-value,
 *  not per-filter, grain, so it is not a fourth member of this union. */
export type FilterState = 'PASSED' | 'FAILED' | 'NOT_ENFORCED';

/** Evaluation order == drop precedence: the first FAILED (never a NOT_ENFORCED) wins. */
export const HARD_FILTER_ORDER: readonly HardFilterReason[] = [
  'VEHICLE_ON_TRIP',
  'SE_UNAVAILABLE',
  'OVER_CAPACITY',
  'COMMON_KIT_INCOMPLETE',
  'COMPONENT_UNAVAILABLE',
];

export interface HardFilterResult<T extends SeCandidateReadiness> {
  passed: T[];
  dropped: { candidate: T; reason: HardFilterReason }[];
}

/** One filter's tri-state verdict for one candidate. NOT_ENFORCED means "no authoritative data source
 *  yet" (Issue 28 / Issue 22) — deliberately distinct from PASSED, which means the filter was actually
 *  evaluated and did not fire. */
function evaluateFilter(c: SeCandidateReadiness, reason: HardFilterReason): FilterState {
  switch (reason) {
    case 'VEHICLE_ON_TRIP':
      if (!c.vehicleReadinessEnforced) return 'NOT_ENFORCED';
      return c.vehicleReadiness === 'ON_TRIP' ? 'FAILED' : 'PASSED';
    case 'SE_UNAVAILABLE':
      return c.available ? 'PASSED' : 'FAILED';
    case 'OVER_CAPACITY':
      return c.overCapacity ? 'FAILED' : 'PASSED';
    case 'COMMON_KIT_INCOMPLETE':
      return c.commonKitComplete ? 'PASSED' : 'FAILED';
    case 'COMPONENT_UNAVAILABLE':
      if (!c.componentAvailabilityEnforced) return 'NOT_ENFORCED';
      return c.expectedComponentsAvailable ? 'PASSED' : 'FAILED';
  }
}

/** Every filter's tri-state verdict for one candidate, in evaluation order — the shape the trace and
 *  admin drawer render (#270 AC1-3). */
export function evaluateAllFilters(
  c: SeCandidateReadiness,
): { filter: HardFilterReason; state: FilterState }[] {
  return HARD_FILTER_ORDER.map((filter) => ({ filter, state: evaluateFilter(c, filter) }));
}

/** The filters currently reporting NOT_ENFORCED for a candidate — identical for every candidate today
 *  (both stubbed feeds are global), kept as a per-candidate read so it stays correct the moment either
 *  feed goes live for real data while the other is still stubbed. */
export function notEnforcedFilters(c: SeCandidateReadiness): HardFilterReason[] {
  return evaluateAllFilters(c)
    .filter((f) => f.state === 'NOT_ENFORCED')
    .map((f) => f.filter);
}

/** The first FAILED reason for a candidate, or null if it survives all filters. NOT_ENFORCED never
 *  drops (Phase 1 ruling, #258 Q5) — it is skipped exactly like a PASSED. */
function firstFailure(c: SeCandidateReadiness): HardFilterReason | null {
  for (const reason of HARD_FILTER_ORDER) {
    if (evaluateFilter(c, reason) === 'FAILED') return reason;
  }
  return null;
}

export function applyHardFilters<T extends SeCandidateReadiness>(
  candidates: readonly T[],
): HardFilterResult<T> {
  const passed: T[] = [];
  const dropped: { candidate: T; reason: HardFilterReason }[] = [];
  for (const c of candidates) {
    const reason = firstFailure(c);
    if (reason === null) passed.push(c);
    else dropped.push({ candidate: c, reason });
  }
  return { passed, dropped };
}
