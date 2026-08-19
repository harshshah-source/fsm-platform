/**
 * Canonical candidate processing order (ADR-0017). Pure + deterministic so Day Plans are reproducible
 * and the Plant Cluster Multiplier (the first same-Plant candidate is the cluster seed) behaves the
 * same way every run. Order: Company Tier desc → Device Bucket desc → **Return Due Today desc (#248,
 * below CRITICAL+ only)** → Company Priority Rank asc → Oldest Inactive asc → Device ID asc.
 *
 * **This comparator is the only thing that orders the dispatch path — there is no SQL mirror** (#248
 * AC6). The docstring claimed for a long time that "the live query mirrors it as a stable SQL ORDER
 * BY"; it does not and never did. `recommender.service.ts`'s selection read carries no `orderBy` at
 * all and the sort is applied once, in process, to the rows it returned. The correction matters more
 * than a stale comment usually would: believing a mirror exists invites someone to "restore" one, and
 * a second ordering written in SQL is precisely the divergence `deferral.ts` exists to prevent. The
 * rank expressions in `device.service.ts` / `ticket-query.service.ts` are unrelated display sorts.
 */

import { isCriticalPlus } from '../device-state/sla-bucket';

export type CompanyTier = 'PLATINUM' | 'GOLD' | 'SILVER';
export type DeviceBucket =
  | 'WARNING'
  | 'EARLY_RISK'
  | 'RISK'
  | 'CRITICAL'
  | 'HIGH_CRITICAL'
  | 'SEVERE'
  | 'VERY_SEVERE'
  | 'LONG_PENDING';

export interface CandidateTicket {
  ticketId: string;
  companyTier: CompanyTier;
  deviceBucket: DeviceBucket;
  companyPriorityRank: string;
  latestGpsDatetime: Date | null;
  deviceId: string;
  /**
   * #248 — the ticket has an OPEN vehicle-unavailability report whose authoritative return date has
   * reached today's IST day, so the vehicle is due back and the ticket has just re-entered the pool.
   *
   * Derived per run and never stored (AC2). Optional because it is a *fact about this run*, not a
   * property of a candidate: absent means "no live vehicle wait", which is true of every candidate the
   * ADR-0017 spec-pins construct and of every ticket that has never had a report. Making it required
   * would force every fixture to restate a default and would tempt a caller into persisting it.
   */
  returnDueToday?: boolean;
}

// Higher index = higher priority (processed first), matching the "descending" intent of ADR-0017.
const TIER_ORDER: CompanyTier[] = ['SILVER', 'GOLD', 'PLATINUM'];
const BUCKET_ORDER: DeviceBucket[] = [
  'WARNING',
  'EARLY_RISK',
  'RISK',
  'CRITICAL',
  'HIGH_CRITICAL',
  'SEVERE',
  'VERY_SEVERE',
  'LONG_PENDING',
];

const tierRank = (t: CompanyTier): number => TIER_ORDER.indexOf(t);

// TIER_ORDER's effective priority, highest first — the same order Issue 157's `tiers.rank`
// encodes right-side-up. Derived (not hand-duplicated) so a drift between the two encodings is
// a real test failure, not two copies of the same literal (Issue 157 AC-1 spec-pin).
export const TIER_ORDER_EFFECTIVE_PRIORITY_DESC: CompanyTier[] = [...TIER_ORDER].reverse();
const bucketRank = (b: DeviceBucket): number => BUCKET_ORDER.indexOf(b);
// A device with no GPS timestamp sorts last among "oldest inactive" ties (treated as newest).
const inactiveKey = (d: Date | null): number => (d === null ? Number.POSITIVE_INFINITY : d.getTime());

export function compareCandidates(a: CandidateTicket, b: CandidateTicket): number {
  // 1. Company Tier descending.
  if (a.companyTier !== b.companyTier) return tierRank(b.companyTier) - tierRank(a.companyTier);
  // 2. Device Bucket descending.
  if (a.deviceBucket !== b.deviceBucket) return bucketRank(b.deviceBucket) - bucketRank(a.deviceBucket);
  // 2b. Return Due Today, true first — #248 / Decision 15, Option C: Critical/Severe → return-date →
  // normal backlog. Gated to buckets below CRITICAL+, and placed *after* step 2 so that gate can never
  // be reached across the CRITICAL boundary: a CRITICAL+ ticket has already been ordered ahead by
  // bucket, and a returning ticket that has itself aged into CRITICAL+ sorts by bucket alone and never
  // consults this key. Both directions are what makes it a rank *below* severity rather than a second
  // priority system competing with it — which is why the alternative (promoting `sla_bucket`) was
  // rejected: that column feeds Fleet Uptime, the Soft Inactive Count zones are graded on, SLA
  // reporting and the decision traces.
  //
  // Step 2 returns whenever the buckets differ, so in practice this decides only between tickets that
  // share a sub-CRITICAL bucket — where it outranks Company Priority Rank. The gate is written as a
  // two-sided check anyway: it states the invariant the placement relies on instead of depending on it.
  if (!isCriticalPlus(a.deviceBucket) && !isCriticalPlus(b.deviceBucket)) {
    // A boolean introduces no ties the keys below do not already break, so determinism is unchanged.
    const aDue = a.returnDueToday === true;
    const bDue = b.returnDueToday === true;
    if (aDue !== bDue) return aDue ? -1 : 1;
  }
  // 3. Company Priority Rank ascending (A before B before C …).
  if (a.companyPriorityRank !== b.companyPriorityRank)
    return a.companyPriorityRank < b.companyPriorityRank ? -1 : 1;
  // 4. Oldest Inactive ascending (older = smaller timestamp = first).
  const ak = inactiveKey(a.latestGpsDatetime);
  const bk = inactiveKey(b.latestGpsDatetime);
  if (ak !== bk) return ak - bk;
  // 5. Device ID ascending — absolute tie-breaker.
  if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1;
  return 0;
}

/** Return a new array in canonical order; does not mutate the input. */
export function canonicalSort<T extends CandidateTicket>(candidates: readonly T[]): T[] {
  return [...candidates].sort(compareCandidates);
}

/**
 * An Install-backlog candidate (Issue 75). Installs have no Failure Cycle / SLA bucket, so they are
 * ordered separately and processed **after** all TROUBLESHOOT candidates (they fill remaining SE
 * capacity in PREVENTIVE mode). `backlogAnchor` is the install target date (or createdAt) — oldest first.
 */
export interface InstallCandidate {
  ticketId: string;
  companyTier: CompanyTier;
  companyPriorityRank: string;
  backlogAnchor: Date | null;
}

/** A null backlog anchor sorts last (treated as newest), mirroring `inactiveKey`. */
const anchorKey = (d: Date | null): number => (d === null ? Number.POSITIVE_INFINITY : d.getTime());

/** Compare two installs: Company Tier desc → Priority Rank asc → oldest backlog → ticketId asc. */
export function compareInstallCandidates(a: InstallCandidate, b: InstallCandidate): number {
  if (a.companyTier !== b.companyTier) return tierRank(b.companyTier) - tierRank(a.companyTier);
  if (a.companyPriorityRank !== b.companyPriorityRank) return a.companyPriorityRank < b.companyPriorityRank ? -1 : 1;
  const ak = anchorKey(a.backlogAnchor);
  const bk = anchorKey(b.backlogAnchor);
  if (ak !== bk) return ak - bk;
  if (a.ticketId !== b.ticketId) return a.ticketId < b.ticketId ? -1 : 1;
  return 0;
}

/** Return the Install backlog in processing order; does not mutate the input. */
export function installSort<T extends InstallCandidate>(candidates: readonly T[]): T[] {
  return [...candidates].sort(compareInstallCandidates);
}
