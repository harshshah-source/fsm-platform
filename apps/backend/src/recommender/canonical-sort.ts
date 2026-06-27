/**
 * Canonical candidate processing order (ADR-0017). Pure + deterministic so Day Plans are reproducible
 * and the Plant Cluster Multiplier (the first same-Plant candidate is the cluster seed) behaves the
 * same way every run. Enforced here as a comparator; the live query mirrors it as a stable SQL
 * ORDER BY. Order: Company Tier desc → Device Bucket desc → Company Priority Rank asc → Oldest
 * Inactive asc → Device ID asc.
 */

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
  deviceId: bigint;
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
const bucketRank = (b: DeviceBucket): number => BUCKET_ORDER.indexOf(b);
// A device with no GPS timestamp sorts last among "oldest inactive" ties (treated as newest).
const inactiveKey = (d: Date | null): number => (d === null ? Number.POSITIVE_INFINITY : d.getTime());

export function compareCandidates(a: CandidateTicket, b: CandidateTicket): number {
  // 1. Company Tier descending.
  if (a.companyTier !== b.companyTier) return tierRank(b.companyTier) - tierRank(a.companyTier);
  // 2. Device Bucket descending.
  if (a.deviceBucket !== b.deviceBucket) return bucketRank(b.deviceBucket) - bucketRank(a.deviceBucket);
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
