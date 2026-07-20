import { describe, expect, it } from 'vitest';
import { evaluateRecomputeCanary } from '../src/device-state/recompute-canary';

/**
 * #130 L5 — the semantic canary's decision, isolated as a pure function. A relative eligible-count
 * swing beyond the threshold (in EITHER direction) is a breach; the baseline being absent or 0 is a
 * skip (no relative change is defined). Warns, never blocks — the verdict carries no throw.
 */
describe('evaluateRecomputeCanary', () => {
  it('skips when there is no previous baseline', () => {
    expect(evaluateRecomputeCanary(null, 100, 5)).toBeNull();
    expect(evaluateRecomputeCanary(undefined, 100, 5)).toBeNull();
  });

  it('skips when the previous baseline is 0 (no defined relative change)', () => {
    expect(evaluateRecomputeCanary(0, 100, 5)).toBeNull();
  });

  it('breaches on a rise beyond threshold (the run-65 signature: departed re-entering eligibility)', () => {
    const v = evaluateRecomputeCanary(15_799, 21_000, 5);
    expect(v).not.toBeNull();
    expect(v!.breached).toBe(true);
    expect(v!.deltaPct).toBeGreaterThan(5);
  });

  it('breaches on a drop beyond threshold (the run-64 stub artifact: eligibility collapsing)', () => {
    const v = evaluateRecomputeCanary(15_799, 0, 5);
    expect(v!.breached).toBe(true);
    expect(v!.deltaPct).toBeLessThan(-5);
  });

  it('does not breach a swing within threshold', () => {
    const v = evaluateRecomputeCanary(1000, 1040, 5); // +4%
    expect(v!.breached).toBe(false);
  });

  it('treats exactly-at-threshold as not breached (strictly greater-than)', () => {
    const v = evaluateRecomputeCanary(1000, 1050, 5); // +5% exactly
    expect(v!.breached).toBe(false);
  });
});
