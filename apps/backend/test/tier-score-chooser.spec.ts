import { chooseWithinTier } from '../src/recommender/tier-score-chooser';
import type { CoverageType } from '../src/recommender/candidate-selection.service';

/**
 * #266 / #268 — the extracted tier+score chooser, pinned in isolation from any caller's readiness
 * building or scoring. `recommender-*.e2e-spec.ts` continues to pin the morning batch's end-to-end
 * behaviour through this function; this file pins the function's own contract.
 */
interface Cand {
  seId: string;
  coverageType: CoverageType;
  vehicleReadiness: 'READY' | 'ON_TRIP' | 'STALE' | 'UNKNOWN';
  available: boolean;
  overCapacity: boolean;
  commonKitComplete: boolean;
  expectedComponentsAvailable: boolean;
}

const cand = (seId: string, coverageType: CoverageType): Cand => ({
  seId,
  coverageType,
  vehicleReadiness: 'UNKNOWN',
  available: true,
  overCapacity: false,
  commonKitComplete: true,
  expectedComponentsAvailable: true,
});

describe('#266/#268 — chooseWithinTier', () => {
  it('returns null when there are no candidates', () => {
    const result = chooseWithinTier({ passed: [], scoreFor: () => 0 });
    expect(result).toEqual({ chosen: null, winningTier: null, tierCandidates: [], tierScores: new Map() });
  });

  it('the winning tier is the first candidate\'s tier — precedence order is trusted, not re-derived', () => {
    const passed = [cand('a', 'MULTI_PLANT'), cand('b', 'MULTI_PLANT'), cand('c', 'FLOATING')];
    const result = chooseWithinTier({ passed, scoreFor: () => 1 });
    expect(result.winningTier).toBe('MULTI_PLANT');
    expect(result.tierCandidates.map((c) => c.seId)).toEqual(['a', 'b']);
  });

  it('a FLOATING candidate never outscores an eligible DEDICATED one — score never crosses a tier', () => {
    const passed = [cand('dedicated', 'DEDICATED'), cand('floating', 'FLOATING')];
    const result = chooseWithinTier({
      passed,
      scoreFor: (c) => (c.seId === 'floating' ? 100 : 0), // floating scores far higher
    });
    expect(result.chosen?.seId).toBe('dedicated');
  });

  it('within the winning tier, the highest score wins', () => {
    const passed = [cand('a', 'DEDICATED'), cand('b', 'DEDICATED'), cand('c', 'DEDICATED')];
    const scores: Record<string, number> = { a: 0.3, b: 0.9, c: 0.5 };
    const result = chooseWithinTier({ passed, scoreFor: (c) => scores[c.seId] });
    expect(result.chosen?.seId).toBe('b');
    expect(result.tierScores).toEqual(new Map([['a', 0.3], ['b', 0.9], ['c', 0.5]]));
  });

  it('ties break on seId ascending — deterministic, not insertion order', () => {
    const passed = [cand('z', 'DEDICATED'), cand('a', 'DEDICATED'), cand('m', 'DEDICATED')];
    const result = chooseWithinTier({ passed, scoreFor: () => 1 });
    expect(result.chosen?.seId).toBe('a');
  });

  it('a pin overrides the score AND crosses tiers — searched across every passing candidate', () => {
    const passed = [cand('dedicated', 'DEDICATED'), cand('planned-floating', 'FLOATING')];
    const result = chooseWithinTier({
      passed,
      scoreFor: () => 0,
      pinnedSeIds: new Set(['planned-floating']),
    });
    expect(result.chosen?.seId).toBe('planned-floating');
    // The winning tier and tierScores still reflect the untouched tier+score computation — the pin
    // overrides the OUTPUT, it does not rewrite the tier scan.
    expect(result.winningTier).toBe('DEDICATED');
  });

  it('a pin naming nobody in `passed` is silently ignored — falls through to tier+score', () => {
    const passed = [cand('a', 'DEDICATED')];
    const result = chooseWithinTier({ passed, scoreFor: () => 1, pinnedSeIds: new Set(['nobody']) });
    expect(result.chosen?.seId).toBe('a');
  });

  it('scoreFor is called only for candidates in the winning tier, not the whole pool', () => {
    const passed = [cand('a', 'DEDICATED'), cand('b', 'FLOATING')];
    const called: string[] = [];
    chooseWithinTier({
      passed,
      scoreFor: (c) => {
        called.push(c.seId);
        return 1;
      },
    });
    expect(called).toEqual(['a']);
  });
});
