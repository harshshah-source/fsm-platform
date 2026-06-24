import { describe, expect, it } from 'vitest';
import { meetsRecoveryCriteria } from '../src/ticketing/recovery-criteria';

/**
 * Issue 08 slice 1 — the auto-recovery ping criteria (CONTEXT "Auto-Recovery").
 *
 * A device is considered recovered when it resumes pinging: ≥3 pings spanning ≥15 minutes (the
 * shared ping-evidence rule; the fuller three-phase stability window is Issue 18). Pure function of
 * the recovery ping timestamps observed after the Failure Cycle opened.
 */
const base = Date.UTC(2026, 5, 20, 12, 0, 0);
const at = (mins: number) => new Date(base + mins * 60_000);

describe('Issue 08 slice 1 — meetsRecoveryCriteria', () => {
  it('is false below the minimum ping count', () => {
    expect(meetsRecoveryCriteria([at(0), at(20)])).toBe(false);
  });

  it('is true with ≥3 pings spanning ≥15 minutes', () => {
    expect(meetsRecoveryCriteria([at(0), at(8), at(16)])).toBe(true);
  });

  it('is true exactly at the 15-minute span boundary', () => {
    expect(meetsRecoveryCriteria([at(0), at(7), at(15)])).toBe(true);
  });

  it('is false when 3 pings span under 15 minutes', () => {
    expect(meetsRecoveryCriteria([at(0), at(5), at(14)])).toBe(false);
  });

  it('honours custom thresholds', () => {
    expect(meetsRecoveryCriteria([at(0), at(30)], { minPings: 2, minSpanMinutes: 15 })).toBe(true);
  });

  it('is order-independent', () => {
    expect(meetsRecoveryCriteria([at(16), at(0), at(8)])).toBe(true);
  });
});
