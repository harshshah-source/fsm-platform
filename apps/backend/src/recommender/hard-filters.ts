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
  available: boolean;
  overCapacity: boolean;
  commonKitComplete: boolean;
  expectedComponentsAvailable: boolean;
}

export type HardFilterReason =
  | 'VEHICLE_ON_TRIP'
  | 'SE_UNAVAILABLE'
  | 'OVER_CAPACITY'
  | 'COMMON_KIT_INCOMPLETE'
  | 'COMPONENT_UNAVAILABLE';

export interface HardFilterResult<T extends SeCandidateReadiness> {
  passed: T[];
  dropped: { candidate: T; reason: HardFilterReason }[];
}

/** The first failing reason for a candidate, or null if it survives all filters. */
function firstFailure(c: SeCandidateReadiness): HardFilterReason | null {
  if (c.vehicleReadiness === 'ON_TRIP') return 'VEHICLE_ON_TRIP';
  if (!c.available) return 'SE_UNAVAILABLE';
  if (c.overCapacity) return 'OVER_CAPACITY';
  if (!c.commonKitComplete) return 'COMMON_KIT_INCOMPLETE';
  if (!c.expectedComponentsAvailable) return 'COMPONENT_UNAVAILABLE';
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
