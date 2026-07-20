import { describe, expect, it } from 'vitest';
import {
  BUCKET_LABEL_RANGE,
  BUCKET_RANGE_LABEL,
  SLA_BUCKETS,
  type SlaBucket,
} from '../src/lib/slaBucket';

/**
 * SLA bucket labels carry their real inactivity range, from ONE shared mapping derived from the
 * backend `SLA_BANDS` (never hardcoded per page). Sub-3-day bands read in hours (`Hr`), 3-day+ bands in
 * days, the top band open-ended. These are the exact strings every dashboard card, overview header,
 * filter and the device table must render. The severity word is no longer shown — the range IS the
 * label (product-owner request).
 */
describe('SLA bucket range mapping (single source of truth)', () => {
  it('renders each bucket range in the canonical compact format', () => {
    const expected: Record<SlaBucket, string> = {
      LONG_PENDING: '7d+',
      VERY_SEVERE: '5–7d',
      SEVERE: '3–5d',
      HIGH_CRITICAL: '48–72Hr',
      CRITICAL: '24–48Hr',
      RISK: '12–24Hr',
      EARLY_RISK: '8–12Hr',
      WARNING: '4–8Hr',
    };
    for (const b of SLA_BUCKETS) {
      expect(BUCKET_RANGE_LABEL[b]).toBe(expected[b]);
    }
  });

  it('exposes a combined descriptor that is now the range itself (no severity word)', () => {
    expect(BUCKET_LABEL_RANGE.LONG_PENDING).toBe('7d+');
    expect(BUCKET_LABEL_RANGE.CRITICAL).toBe('24–48Hr');
    expect(BUCKET_LABEL_RANGE.WARNING).toBe('4–8Hr');
    expect(BUCKET_LABEL_RANGE.HIGH_CRITICAL).toBe('48–72Hr');
    // the combined descriptor equals the range mapping for every bucket
    for (const b of SLA_BUCKETS) {
      expect(BUCKET_LABEL_RANGE[b]).toBe(BUCKET_RANGE_LABEL[b]);
      expect(BUCKET_LABEL_RANGE[b].length).toBeGreaterThan(0);
    }
  });
});
