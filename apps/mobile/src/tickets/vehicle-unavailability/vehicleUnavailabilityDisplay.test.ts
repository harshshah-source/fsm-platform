import { describe, expect, it } from '@jest/globals';
import {
  formatReasonLabel,
  formatReturnDay,
  istInstantFromEntry,
} from './vehicleUnavailabilityDisplay';

describe('formatReasonLabel', () => {
  it('title-cases a multi-word reason', () => {
    expect(formatReasonLabel('VEHICLE_ON_TRIP')).toBe('Vehicle On Trip');
    expect(formatReasonLabel('OTHER')).toBe('Other');
  });
});

/**
 * #246 — the four-preset ladder capped at ~tomorrow 2 PM, so "next week" was literally inexpressible
 * on the one screen whose whole job is saying when a vehicle comes back. Free date entry replaces it.
 */
describe('istInstantFromEntry', () => {
  it('reads a bare date as IST midnight, not the device timezone', () => {
    // 00:00 IST on the 27th is 18:30 UTC on the 26th. Anchoring to IST explicitly keeps the value
    // the SE meant regardless of what the handset's clock is set to — and IST is the operating day
    // the server buckets deferrals by, so client and server agree by construction.
    expect(istInstantFromEntry('2026-06-27')).toBe('2026-06-26T18:30:00.000Z');
  });

  it('applies an optional time on the same IST day', () => {
    expect(istInstantFromEntry('2026-06-27', '14:30')).toBe('2026-06-27T09:00:00.000Z');
  });

  it('accepts a date arbitrarily far out — no horizon (Decision 10)', () => {
    expect(istInstantFromEntry('2027-03-01')).toBe('2027-02-28T18:30:00.000Z');
  });

  it('rejects malformed entry rather than guessing', () => {
    for (const bad of ['', '27-06-2026', '2026-6-7', '2026-02-31', 'next week']) {
      expect(istInstantFromEntry(bad)).toBeNull();
    }
    expect(istInstantFromEntry('2026-06-27', '9am')).toBeNull();
    expect(istInstantFromEntry('2026-06-27', '25:00')).toBeNull();
  });
});

describe('formatReturnDay', () => {
  it('renders the IST calendar day the server decided on', () => {
    expect(formatReturnDay('2026-06-27T00:00:00.000Z')).toBe('27 Jun 2026');
  });

  it('has nothing to render when there is no wait', () => {
    expect(formatReturnDay(null)).toBeNull();
  });
});
