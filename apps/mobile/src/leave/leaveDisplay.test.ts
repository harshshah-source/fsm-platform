import { describe, expect, it } from '@jest/globals';
import { formatLeaveTypeLabel, formatLeaveWindowEnd, formatLeaveWindowStart, leaveStatusLabel } from './leaveDisplay';

/**
 * #204 / B8 — the server now stores a leave window as the real instants bounding the **IST** days it
 * covers: 10–12 Aug is `2026-08-09T18:30Z` … `2026-08-12T18:30Z` (end-exclusive, so the end instant is
 * IST midnight *opening* the 13th). Slicing the ISO string, which is what this file used to do, would
 * render that as "2026-08-09 – 2026-08-12" — a start one day early.
 */
describe('#204 — leave window dates render as IST calendar days', () => {
  const START = '2026-08-09T18:30:00.000Z'; // 00:00 IST on the 10th
  const END = '2026-08-12T18:30:00.000Z'; // 00:00 IST on the 13th — exclusive

  it('renders the IST day the window starts on, not the UTC one', () => {
    expect(formatLeaveWindowStart(START)).toBe('2026-08-10');
  });

  it('renders the last IST day the window actually covers, not the exclusive end', () => {
    expect(formatLeaveWindowEnd(END)).toBe('2026-08-12');
  });

  it('renders a single-day leave as the same date on both ends', () => {
    expect(formatLeaveWindowStart('2026-08-09T18:30:00.000Z')).toBe('2026-08-10');
    expect(formatLeaveWindowEnd('2026-08-10T18:30:00.000Z')).toBe('2026-08-10');
  });

  it('renders a window a manager set at a specific time on its own IST day', () => {
    // A ZM-set instant window (09:00–17:00 IST) is not a calendar day, but it still reads as the day
    // it falls on — and the end must not roll back into the previous day.
    expect(formatLeaveWindowStart('2026-08-10T03:30:00.000Z')).toBe('2026-08-10');
    expect(formatLeaveWindowEnd('2026-08-10T11:30:00.000Z')).toBe('2026-08-10');
  });

  it('degrades to an em dash rather than NaN for an unparseable value', () => {
    expect(formatLeaveWindowStart('')).toBe('—');
    expect(formatLeaveWindowEnd('not-a-date')).toBe('—');
  });

  it('leaves the label helpers alone', () => {
    expect(formatLeaveTypeLabel('WEEKLY_OFF')).toBe('Weekly Off');
    expect(leaveStatusLabel('PENDING')).toBe('Pending');
  });
});
