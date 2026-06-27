import { scoreCandidate, type ScoringFeatures, type ScoringWeights } from '../src/recommender/scoring';

/**
 * Issue 72 slice 1 — `scoreCandidate` supports the PREVENTIVE weight set. DEFICIT keeps today's formula
 * exactly (repeat-failure is a penalty; new weights absent → no effect). PREVENTIVE turns repeat-failure
 * into a bonus and adds a device-age term, so repeat-offenders and aged devices score higher. Pure unit.
 */
const DEFICIT: ScoringWeights = { company_priority_rank: 0.4, dispatch_urgency: 0.3, repeat_failure_penalty: 0.2, distance: 0.1 };
const PREVENTIVE: ScoringWeights = { company_priority_rank: 0.4, dispatch_urgency: 0.3, repeat_failure_penalty: 0, repeat_failure_bonus: 0.5, device_age: 0.5, distance: 0.1 };

const base = (over: Partial<ScoringFeatures> = {}): ScoringFeatures => ({
  companyPriorityRank: 'B',
  dispatchUrgency: 0.5,
  repeatFailure: false,
  inactivityHours: null,
  distanceFromPrevStopKm: null,
  ...over,
});

describe('Issue 72 slice 1 — scoreCandidate preventive weights', () => {
  it('DEFICIT: repeat-failure lowers the score (unchanged penalty behaviour)', () => {
    const clean = scoreCandidate(base({ repeatFailure: false }), DEFICIT).score;
    const repeat = scoreCandidate(base({ repeatFailure: true }), DEFICIT).score;
    expect(repeat).toBeLessThan(clean);
  });

  it('DEFICIT: device age does not affect the score (no age weight in the set)', () => {
    const fresh = scoreCandidate(base({ inactivityHours: 1 }), DEFICIT).score;
    const aged = scoreCandidate(base({ inactivityHours: 200 }), DEFICIT).score;
    expect(aged).toBe(fresh);
  });

  it('PREVENTIVE: repeat-failure raises the score (bonus, not penalty)', () => {
    const clean = scoreCandidate(base({ repeatFailure: false }), PREVENTIVE).score;
    const repeat = scoreCandidate(base({ repeatFailure: true }), PREVENTIVE).score;
    expect(repeat).toBeGreaterThan(clean);
  });

  it('PREVENTIVE: an older (more inactive) device scores higher', () => {
    const fresh = scoreCandidate(base({ inactivityHours: 1 }), PREVENTIVE).score;
    const aged = scoreCandidate(base({ inactivityHours: 200 }), PREVENTIVE).score;
    expect(aged).toBeGreaterThan(fresh);
  });

  it('exposes ageScore in the breakdown for explainability', () => {
    const out = scoreCandidate(base({ inactivityHours: 168 }), PREVENTIVE);
    expect(out.breakdown.ageScore).toBeGreaterThan(0);
  });
});
