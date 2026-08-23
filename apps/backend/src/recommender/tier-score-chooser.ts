import type { CoverageType } from './candidate-selection.service';
import type { SeCandidateReadiness } from './hard-filters';

/**
 * #266 / #268 — the tier+score chooser, extracted so the morning batch and the CRITICAL direct-assign
 * sweep select an SE by the SAME discipline instead of two independently-maintained copies of it.
 *
 * This is steps 1-3 of `RecommenderService`'s per-ticket selection, unchanged in substance, lifted out
 * because #268 needed it from `IntradayInsertionService` and the issue's own instruction was explicit:
 * reuse, do not re-implement. `applyHardFilters`/`buildCandidateReadiness` made the same move for
 * eligibility (#274); this is the analogous seam for the choice among the eligible.
 *
 * **What it does NOT do.** It does not build readiness (that is `buildCandidateReadiness`), does not
 * run the hard filters (`applyHardFilters` — the caller passes `passed`, already filtered and in
 * coverage-precedence order: dedicated → multi-plant → floating), and does not score (`scoreCandidate`
 * — the caller supplies `scoreFor`, since the ticket-level features and weight set differ by caller and
 * scoring one candidate needs both). What it owns is the three-step decision on top of those: which
 * tier wins, who scores best within it, and whether a pin overrides both.
 */
export interface ChooseWithinTierInput<T extends SeCandidateReadiness & { seId: string; coverageType: CoverageType }> {
  /** Hard-filtered candidates, already in coverage-precedence order. */
  passed: readonly T[];
  /** This candidate's score within the winning tier. Called only for candidates in that tier. */
  scoreFor: (candidate: T) => number;
  /**
   * SE Planner soft bias (ADR-0022). Searched across ALL passing candidates, not just the winning
   * tier — Q1's "precedence is inviolable" binds the SCORE; a human's explicit pin still crosses it.
   * Omitted entirely by a caller with no planner concept of its own (#268's intraday direct-assign).
   */
  pinnedSeIds?: ReadonlySet<string>;
}

export interface ChosenCandidate<T> {
  /** The winner, or null when `passed` was empty. */
  chosen: T | null;
  winningTier: CoverageType | null;
  /** Every candidate in the winning tier — the pool `chosen` (absent a pin) was scored against. */
  tierCandidates: readonly T[];
  /** seId → score, for the winning tier only. */
  tierScores: ReadonlyMap<string, number>;
}

/**
 * Step 1: the winning tier is the first non-empty tier in precedence order — `passed` is already in
 * that order, so this is a scan, not a sort, and a lower tier is reached only when every higher-tier
 * candidate was filtered out. A FLOATING SE can therefore never out-score an eligible DEDICATED one:
 * the score is only ever consulted *within* one tier.
 *
 * Step 2: score every candidate in the winning tier via the caller's `scoreFor`.
 *
 * Step 3: selection order — the pin, then the winning tier's top score, then `se_id` ascending as the
 * deterministic tie-break (two runs on one fixture must agree, not "whatever the database returned
 * first").
 */
export function chooseWithinTier<T extends SeCandidateReadiness & { seId: string; coverageType: CoverageType }>(
  input: ChooseWithinTierInput<T>,
): ChosenCandidate<T> {
  const { passed, scoreFor, pinnedSeIds } = input;
  const winningTier = passed[0]?.coverageType ?? null;
  const tierCandidates = passed.filter((c) => c.coverageType === winningTier);
  const tierScores = new Map<string, number>(tierCandidates.map((c) => [c.seId, scoreFor(c)]));

  const pinned = pinnedSeIds ? passed.find((c) => pinnedSeIds.has(c.seId)) : undefined;
  const chosen =
    pinned ??
    [...tierCandidates].sort((a, b) => {
      const byScore = (tierScores.get(b.seId) ?? 0) - (tierScores.get(a.seId) ?? 0);
      return byScore !== 0 ? byScore : a.seId.localeCompare(b.seId);
    })[0] ??
    null;

  return { chosen, winningTier, tierCandidates, tierScores };
}
