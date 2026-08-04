import { describe, expect, it } from '@jest/globals';
import { EXPECTED_FROM_OPTIONS, formatReasonLabel } from './vehicleUnavailabilityDisplay';

describe('formatReasonLabel', () => {
  it('title-cases a multi-word reason', () => {
    expect(formatReasonLabel('VEHICLE_ON_TRIP')).toBe('Vehicle On Trip');
    expect(formatReasonLabel('OTHER')).toBe('Other');
  });
});

describe('EXPECTED_FROM_OPTIONS', () => {
  it('computes each option strictly after now', () => {
    const now = new Date('2026-05-11T10:00:00Z');
    for (const option of EXPECTED_FROM_OPTIONS) {
      expect(option.compute(now).getTime()).toBeGreaterThan(now.getTime());
    }
  });

  it('"Tomorrow, 9 AM" lands on the next calendar day at 09:00 local', () => {
    const now = new Date('2026-05-11T10:00:00Z');
    const option = EXPECTED_FROM_OPTIONS.find((o) => o.key === 'tomorrow-am')!;
    const result = option.compute(now);
    expect(result.getDate()).toBe(now.getDate() + 1);
    expect(result.getHours()).toBe(9);
  });
});
