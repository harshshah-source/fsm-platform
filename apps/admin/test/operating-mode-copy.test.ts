import { describe, expect, it } from 'vitest';
import type { ZoneOperatingMode } from '../src/api/operatingMode';
import { operatingModeCopy } from '../src/utils/operatingModeCopy';

/**
 * Issue 136 — the single vocabulary util. Guards the hard rule: no engine term (DEFICIT / PREVENTIVE /
 * threshold / soft inactive count) ever appears in rendered copy, and the counts become a plain
 * sentence (no %, no "threshold").
 */
const row = (over: Partial<ZoneOperatingMode>): ZoneOperatingMode => ({
  zoneId: '1',
  zoneName: 'North',
  mode: 'PREVENTIVE',
  silentCount: 0,
  eligibleCount: 100,
  ...over,
});

const ENGINE_TERMS = /deficit|preventive|threshold|soft.?inactive/i;

describe('operatingModeCopy', () => {
  it('maps DEFICIT to the "Catch-up" label with an attention tone', () => {
    const c = operatingModeCopy(row({ mode: 'DEFICIT', silentCount: 142, eligibleCount: 3010 }));
    expect(c.label).toBe('Catch-up');
    expect(c.tone).toBe('attention');
    expect(c.reason.length).toBeGreaterThan(0);
    expect(c.primaryFact).toBe('142 of 3,010 devices we track in your zone are currently quiet.');
  });

  it('maps PREVENTIVE to the "Steady" label with a calm tone', () => {
    const c = operatingModeCopy(row({ mode: 'PREVENTIVE', silentCount: 4, eligibleCount: 880 }));
    expect(c.label).toBe('Steady');
    expect(c.tone).toBe('calm');
    expect(c.primaryFact).toBe('4 of 880 devices we track in your zone are currently quiet.');
  });

  it('never leaks an engine term into any rendered field', () => {
    for (const mode of ['DEFICIT', 'PREVENTIVE'] as const) {
      for (const perspective of ['self', 'other'] as const) {
        const c = operatingModeCopy(row({ mode, silentCount: 5, eligibleCount: 50 }), perspective);
        expect(c.label).not.toMatch(ENGINE_TERMS);
        expect(c.reason).not.toMatch(ENGINE_TERMS);
        expect(c.primaryFact).not.toMatch(ENGINE_TERMS);
        // No percentage vocabulary either.
        expect(c.primaryFact).not.toContain('%');
      }
    }
  });

  it('renders an honest fact when the zone tracks no eligible devices (no NaN / divide-by-zero)', () => {
    const self = operatingModeCopy(row({ mode: 'PREVENTIVE', silentCount: 0, eligibleCount: 0 }), 'self');
    expect(self.primaryFact).toBe("We aren't tracking any devices in your zone yet.");
    expect(self.primaryFact).not.toMatch(/NaN/);
    const other = operatingModeCopy(row({ mode: 'PREVENTIVE', silentCount: 0, eligibleCount: 0 }), 'other');
    expect(other.primaryFact).toBe('No devices tracked yet.');
  });

  it('uses a compact third-person fact for the cross-zone (other) perspective', () => {
    const c = operatingModeCopy(row({ mode: 'DEFICIT', silentCount: 12, eligibleCount: 400 }), 'other');
    expect(c.primaryFact).toBe('12 of 400 devices quiet.');
  });
});
