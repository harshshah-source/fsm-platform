import { describe, expect, it } from 'vitest';
import { istWindowEndDate, istWindowStartDate } from '../src/lib/datetime';

/**
 * #204 / B8 — the server stores a leave/availability window as the real instants bounding the **IST**
 * days it covers, so 10–12 Aug is `2026-08-09T18:30Z` … `2026-08-12T18:30Z` (end-exclusive: the end
 * instant is IST midnight *opening* the 13th). `iso.slice(0, 10)` — what `LeaveRequestsPage` and
 * `SeManagementPage` used to do — renders that as "2026-08-09 – 2026-08-12", a start one day early.
 * This is #204's finding B7 (latent admin date-render traps) going live, exactly as the issue
 * anticipated it would once the boundary moved.
 */
describe('#204 — admin renders window instants as IST calendar days', () => {
  it('renders the IST day the window starts on, not the UTC one', () => {
    expect(istWindowStartDate('2026-08-09T18:30:00.000Z')).toBe('2026-08-10');
  });

  it('renders the last IST day the window actually covers, not the exclusive end', () => {
    expect(istWindowEndDate('2026-08-12T18:30:00.000Z')).toBe('2026-08-12');
  });

  it('renders a single-day window as the same date on both ends', () => {
    expect(istWindowStartDate('2026-08-09T18:30:00.000Z')).toBe('2026-08-10');
    expect(istWindowEndDate('2026-08-10T18:30:00.000Z')).toBe('2026-08-10');
  });

  it('keeps a manager-set instant window on the IST day it falls on', () => {
    // 09:00–17:00 IST, the shape `datetime-local` produces — not a calendar day, but it must read as
    // the day it happens on, and the end must not roll back into the previous day.
    expect(istWindowStartDate('2026-08-10T03:30:00.000Z')).toBe('2026-08-10');
    expect(istWindowEndDate('2026-08-10T11:30:00.000Z')).toBe('2026-08-10');
  });

  it('keeps a window that ends in the small hours IST on that day', () => {
    expect(istWindowEndDate('2026-08-09T20:00:00.000Z')).toBe('2026-08-10'); // 01:30 IST on the 10th
  });

  it('degrades to an em dash rather than NaN for an unparseable value', () => {
    expect(istWindowStartDate('')).toBe('—');
    expect(istWindowEndDate('not-a-date')).toBe('—');
  });
});
