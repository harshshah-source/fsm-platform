import { describe, expect, it } from 'vitest';
import {
  BUCKET_LABEL_RANGE,
  BUCKET_RANGE_LABEL,
  SLA_BUCKETS,
  type SlaBucket,
} from '../src/lib/slaBucket';

/**
 * Change #2 — SLA bucket labels carry their real inactivity range, from ONE shared mapping derived
 * from the backend `SLA_BANDS` (never hardcoded per page). Sub-3-day bands read in hours, 3-day+ bands
 * in days, the top band open-ended. These are the exact strings every dashboard card, overview header,
 * filter and the device table must render.
 */
describe('SLA bucket range mapping (single source of truth)', () => {
  it('renders each bucket range in the canonical compact format', () => {
    const expected: Record<SlaBucket, string> = {
      LONG_PENDING: '7d+',
      VERY_SEVERE: '5–7d',
      SEVERE: '3–5d',
      HIGH_CRITICAL: '48–72h',
      CRITICAL: '24–48h',
      RISK: '12–24h',
      EARLY_RISK: '8–12h',
      WARNING: '4–8h',
    };
    for (const b of SLA_BUCKETS) {
      expect(BUCKET_RANGE_LABEL[b]).toBe(expected[b]);
    }
  });

  it('exposes a combined "Label (range)" descriptor for every bucket', () => {
    expect(BUCKET_LABEL_RANGE.LONG_PENDING).toBe('Long Pending (7d+)');
    expect(BUCKET_LABEL_RANGE.CRITICAL).toBe('Critical (24–48h)');
    expect(BUCKET_LABEL_RANGE.WARNING).toBe('Warning (4–8h)');
    expect(BUCKET_LABEL_RANGE.HIGH_CRITICAL).toBe('High Critical (48–72h)');
    // every bucket has a non-empty combined descriptor
    for (const b of SLA_BUCKETS) {
      expect(BUCKET_LABEL_RANGE[b]).toMatch(/^.+ \(.+\)$/);
    }
  });
});
