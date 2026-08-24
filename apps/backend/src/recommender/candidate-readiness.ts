import type { SeAvailabilityStatus } from '../generated/prisma/enums';
import type { CoverageType } from './candidate-selection.service';
import type { SeCandidateReadiness } from './hard-filters';

/**
 * Everything the hard filters need to know about one candidate, in the form the two callers can each
 * actually supply.
 *
 * `capacity` is `undefined` when the SE has no `engineer_master` row at all — reachable through the
 * `se_coverage` legs, which are keyed on `se_id` and not on the master table. That is deliberately
 * *not* treated as "over capacity": an engineer must never be filtered out by a missing master-data
 * field, and the recommender has always read it this way.
 */
export interface CandidateReadinessInput {
  seId: string;
  coverageType: CoverageType;
  availabilityStatus: SeAvailabilityStatus;
  /** Stops already counted against the engineer's day — the recommender's running counter during a
   *  run, {@link committedDayLoad}'s figure for a read. #269 made those the same number. */
  committed: number;
  capacity: { dailyCapacity: number; isActive: boolean } | undefined;
  commonKitComplete: boolean;
}

/**
 * The engine's readiness rule, as one function — **the seam #274 exists on**.
 *
 * The dispatch run and the Assign Console's candidate column ask the identical question of the
 * identical facts, and the console's whole value is that its answer is the engine's answer. Sharing
 * `applyHardFilters` alone was never enough: that function is pure and takes readiness as given, so
 * two callers could hand it two different readings of the same engineer — one calling an SE with no
 * master row "over capacity", the other not; one treating SOFT_UNAVAILABLE as available, the other
 * not — and agree perfectly on a rule they were feeding different inputs. That is the *quiet* failure
 * #274's Risks section names: a column that looks right and disagrees with dispatch under load.
 *
 * `vehicleReadiness` is fixed at `UNKNOWN` and `expectedComponentsAvailable` at `true` because both
 * remain unbuilt seams (Issues 28 and 22). Neither is a drop today; when they land they land here,
 * once, for both callers.
 *
 * #270 — `vehicleReadinessEnforced`/`componentAvailabilityEnforced` are `false` here for the same
 * reason: this is the feed site, so it is where "no real data source yet" gets stated, not inferred
 * from the stub value downstream. When Issue 28/22 wire real feeds, flipping these two `false`s to
 * `true` (right here, nowhere else) is the entire seam — `hard-filters.ts` already evaluates real
 * data correctly today, proven by `test/hard-filters.spec.ts`'s enforced-flag cases.
 */
export function buildCandidateReadiness(
  input: CandidateReadinessInput,
): SeCandidateReadiness & { seId: string; coverageType: CoverageType } {
  return {
    seId: input.seId,
    // Carried through `applyHardFilters` (generic over the readiness shape) so tier grouping — the
    // engine's winning tier, the column's headings — needs no second lookup.
    coverageType: input.coverageType,
    vehicleReadiness: 'UNKNOWN',
    vehicleReadinessEnforced: false,
    available: (input.capacity?.isActive ?? true) && input.availabilityStatus === 'AVAILABLE',
    // `>=`, matching #269's `isOverCapacity`: an SE at exactly `6/6` is one no automatic path will
    // add to, so the badge and the filter agree at the boundary rather than one step apart.
    overCapacity: input.capacity !== undefined && input.committed >= input.capacity.dailyCapacity,
    commonKitComplete: input.commonKitComplete,
    expectedComponentsAvailable: true,
    componentAvailabilityEnforced: false,
  };
}
