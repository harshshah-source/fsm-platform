import { expect } from 'vitest';
import type { DispatchRunOutcome, DispatchRunSummary } from '../src/scheduling/dispatch-run.service';

/**
 * Narrow a dispatch outcome to its summary (#213).
 *
 * `runForActiveZones` returns `RAN | CONFLICT` since the in-flight guard moved into it, so a test that
 * wants the summary has to say so. Failing loudly here rather than reading through an optional keeps a
 * guard regression legible: a test that silently starts asserting on `undefined` would report the wrong
 * problem.
 */
export function expectRan(outcome: DispatchRunOutcome): DispatchRunSummary {
  expect(outcome.result).toBe('RAN');
  if (outcome.result !== 'RAN') throw new Error(`expected a dispatch run, got ${outcome.result}`);
  return outcome.summary;
}
