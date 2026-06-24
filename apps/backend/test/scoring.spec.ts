import { scoreCandidate, type ScoringFeatures, type ScoringWeights } from '../src/recommender/scoring';

/**
 * Issue 10, slice 4 — weighted score within a (Company Tier × Device Bucket) cell (ADR-0003 layer 4,
 * AC#4). Combines company_priority_rank, vehicle dispatch urgency, a repeat-failure penalty and (for
 * Floating SEs) distance-from-previous-stop, each scaled by a configurable weight, then multiplied by
 * the Plant Cluster Multiplier for additional same-Plant tickets. Pure + explainable (returns a
 * breakdown for the persisted `score_breakdown`).
 */
const W: ScoringWeights = {
  company_priority_rank: 1,
  dispatch_urgency: 1,
  repeat_failure_penalty: 1,
  distance: 1,
};
const base = (over: Partial<ScoringFeatures> = {}): ScoringFeatures => ({
  companyPriorityRank: 'A',
  dispatchUrgency: 0.5,
  repeatFailure: false,
  distanceFromPrevStopKm: null,
  ...over,
});
const s = (f: ScoringFeatures, w: ScoringWeights = W, mult = 1) => scoreCandidate(f, w, mult).score;

describe('Issue 10 slice 4 — weighted scoring + Plant Cluster Multiplier', () => {
  it('ranks higher Company Priority Rank above lower, all else equal', () => {
    expect(s(base({ companyPriorityRank: 'A' }))).toBeGreaterThan(s(base({ companyPriorityRank: 'B' })));
  });

  it('increases with dispatch urgency and decreases with a repeat-failure penalty', () => {
    expect(s(base({ dispatchUrgency: 0.9 }))).toBeGreaterThan(s(base({ dispatchUrgency: 0.1 })));
    expect(s(base({ repeatFailure: true }))).toBeLessThan(s(base({ repeatFailure: false })));
  });

  it('rewards a nearer previous stop for Floating SEs; null distance is neutral', () => {
    expect(s(base({ distanceFromPrevStopKm: 1 }))).toBeGreaterThan(s(base({ distanceFromPrevStopKm: 9 })));
    // A non-floating candidate (null distance) just omits the distance term.
    const withDist = scoreCandidate(base({ distanceFromPrevStopKm: 1 }), W, 1).breakdown.distanceScore;
    const nullDist = scoreCandidate(base({ distanceFromPrevStopKm: null }), W, 1).breakdown.distanceScore;
    expect(nullDist).toBe(0);
    expect(withDist).toBeGreaterThan(0);
  });

  it('applies the Plant Cluster Multiplier on top of the base score', () => {
    const r = scoreCandidate(base(), W, 1.5);
    expect(r.score).toBeCloseTo(r.breakdown.baseScore * 1.5, 6);
    expect(r.score).toBeGreaterThan(scoreCandidate(base(), W, 1).score);
    expect(r.breakdown.clusterMultiplier).toBe(1.5);
  });

  it('honours configurable weights (zero weight removes a component effect)', () => {
    const noPenalty: ScoringWeights = { ...W, repeat_failure_penalty: 0 };
    expect(s(base({ repeatFailure: true }), noPenalty)).toBe(s(base({ repeatFailure: false }), noPenalty));
  });
});
