import { describe, expect, it } from 'vitest';
import {
  NO_CUBE_LABEL,
  REPORT_CUBE_CADENCE_HOURS,
  REPORT_STALE_AFTER_HOURS,
  REPORT_STALE_AFTER_MS,
  reportAgeLabel,
  reportFreshness,
} from '../src/api/reports';

/**
 * #347 — the freshness rule behind every report's "Data as of" stamp.
 *
 * The defect this closes was not a missing badge; it was a badge with **no threshold anywhere**. The
 * page computed a stamp (`new Date()`, the browser's own clock) and compared it against nothing, so
 * it could never read stale — a cube cron dead for two days still drew a timestamp from this morning
 * over two-day-old numbers. These tests pin that a real age is measured against a real boundary, and
 * that crossing it actually flips the state.
 */
const HOUR = 3_600_000;
const NOW = new Date('2026-09-03T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * HOUR).toISOString();

describe('report freshness (#347)', () => {
  it('the threshold is two missed daily cadences, not an unbounded "recent"', () => {
    expect(REPORT_CUBE_CADENCE_HOURS).toBe(24);
    expect(REPORT_STALE_AFTER_HOURS).toBe(48);
    expect(REPORT_STALE_AFTER_MS).toBe(48 * HOUR);
  });

  it('a cube computed inside the window is fresh', () => {
    const f = reportFreshness(hoursAgo(3), NOW);
    expect(f.state).toBe('fresh');
    expect(f.ageMs).toBe(3 * HOUR);
    expect(f.label).toMatch(/^Data as of /);
  });

  it('a cube one missed sweep old is still fresh — one late cron is not a dead one', () => {
    expect(reportFreshness(hoursAgo(30), NOW).state).toBe('fresh');
  });

  it('flips to stale strictly past the threshold', () => {
    // Exactly at the boundary is not yet stale; a minute past it is.
    expect(reportFreshness(hoursAgo(48), NOW).state).toBe('fresh');
    expect(reportFreshness(new Date(NOW.getTime() - 48 * HOUR - 60_000).toISOString(), NOW).state).toBe('stale');
  });

  it('a two-day-dead scheduler reads stale, which is the whole point', () => {
    const f = reportFreshness(hoursAgo(52), NOW);
    expect(f.state).toBe('stale');
    expect(f.label).toMatch(/^Data as of /);
    expect(reportAgeLabel(f.ageMs!)).toBe('2 days old');
  });

  it('no cube row at all is "missing", never a silently fresh stamp', () => {
    for (const absent of [null, undefined, '']) {
      const f = reportFreshness(absent, NOW);
      expect(f.state).toBe('missing');
      expect(f.label).toBe(NO_CUBE_LABEL);
      expect(f.asOf).toBeNull();
      expect(f.ageMs).toBeNull();
    }
  });

  it('an unparseable stamp is missing rather than fresh — defaulting to "fine" is how this hid', () => {
    expect(reportFreshness('not-a-date', NOW).state).toBe('missing');
  });

  it('a stamp slightly in the future is age 0, not a negative age', () => {
    const f = reportFreshness(new Date(NOW.getTime() + 5 * 60_000).toISOString(), NOW);
    expect(f.state).toBe('fresh');
    expect(f.ageMs).toBe(0);
  });

  it('describes age in the coarsest unit that answers "should I trust this?"', () => {
    expect(reportAgeLabel(20 * 60_000)).toBe('under an hour old');
    expect(reportAgeLabel(5 * HOUR)).toBe('5h old');
    expect(reportAgeLabel(47 * HOUR)).toBe('47h old');
    expect(reportAgeLabel(72 * HOUR)).toBe('3 days old');
  });
});
