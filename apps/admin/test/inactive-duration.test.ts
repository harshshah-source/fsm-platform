import { describe, expect, it } from 'vitest';
import { formatInactiveDuration, formatInactiveOfTotal } from '../src/lib/inactiveDuration';

describe('Issue 2 — formatInactiveOfTotal', () => {
  it('renders `inactive / total`', () => {
    expect(formatInactiveOfTotal(12, 180)).toBe('12 / 180');
    expect(formatInactiveOfTotal(0, 5)).toBe('0 / 5');
  });
  it('degrades to just the inactive count when the total is unknown', () => {
    expect(formatInactiveOfTotal(12, null)).toBe('12');
    expect(formatInactiveOfTotal(12, undefined)).toBe('12');
  });
});

describe('Issue 3 — formatInactiveDuration (compact, two-unit max)', () => {
  const now = new Date('2026-07-01T12:00:00.000Z');
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const MIN = 60_000, HR = 60 * MIN, DAY = 24 * HR;

  it('formats minutes / hours / days like 20m, 2h, 20h, 1d, 4d 6h', () => {
    expect(formatInactiveDuration(ago(20 * MIN), now)).toBe('20m');
    expect(formatInactiveDuration(ago(2 * HR), now)).toBe('2h');
    expect(formatInactiveDuration(ago(20 * HR), now)).toBe('20h');
    expect(formatInactiveDuration(ago(DAY), now)).toBe('1d');
    expect(formatInactiveDuration(ago(4 * DAY + 6 * HR), now)).toBe('4d 6h');
    expect(formatInactiveDuration(ago(2 * HR + 30 * MIN), now)).toBe('2h 30m');
  });

  it('clamps future/skewed timestamps to 0m and returns null when absent', () => {
    expect(formatInactiveDuration(ago(-5 * MIN), now)).toBe('0m');
    expect(formatInactiveDuration(null, now)).toBeNull();
    expect(formatInactiveDuration(undefined, now)).toBeNull();
  });
});
