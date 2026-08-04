import { describe, expect, it } from 'vitest';
import { istDate, istDayStartInstant, istWindowEnd, istWindowStart, IST_OFFSET_MS } from '../src/common/ist-day';

/**
 * #204 / CONTEXT Decisions §19 — the operating day is the `Asia/Kolkata` calendar day.
 *
 * Two distinct values are needed and MUST NOT be conflated, which is the whole reason this file
 * exists as its own seam:
 *
 *  - `istDate(now)`      → UTC midnight of the IST **calendar date**. Postgres `DATE` columns carry
 *                          no timezone and Prisma marshals them to/from UTC midnight, so every
 *                          `@db.Date` comparison (`deferred_until`, `deferred_to_date`, `date_from`,
 *                          `date_to`) must use this form.
 *  - `istDayStartInstant(now)` → the actual **instant** IST midnight occurred (UTC 18:30 the previous
 *                          day). Every `@db.Timestamptz` comparison (`removed_at`) must use this one.
 *
 * Passing the DATE form to a timestamptz comparison silently shifts the window by 5h30m — which is
 * exactly the class of bug the old single `utcDayStart` helper produced at
 * `me-tickets-query.service.ts:64`.
 */
describe('#204 — IST day boundary', () => {
  it('IST is a fixed +05:30 offset (India has never observed DST)', () => {
    expect(IST_OFFSET_MS).toBe((5 * 60 + 30) * 60 * 1000);
  });

  describe('istDate — for @db.Date columns', () => {
    it('returns UTC midnight of the IST calendar date', () => {
      // 2026-08-04T09:00:00Z is 14:30 IST on 4 Aug — squarely mid-day, no edge involved.
      expect(istDate(new Date('2026-08-04T09:00:00Z')).toISOString()).toBe('2026-08-04T00:00:00.000Z');
    });

    it('THE REGRESSION THIS ISSUE EXISTS FOR: 02:00 IST belongs to that IST day, not the previous one', () => {
      // 2026-08-03T20:30:00Z == 2026-08-04 02:00 IST. The retired utcDayStart returned 2026-08-03
      // here, filing an SE's pre-dawn work under the previous calendar day.
      expect(istDate(new Date('2026-08-03T20:30:00Z')).toISOString()).toBe('2026-08-04T00:00:00.000Z');
    });

    it('the instant just before IST midnight still belongs to the outgoing day', () => {
      // 2026-08-03T18:29:59Z == 2026-08-03 23:59:59 IST
      expect(istDate(new Date('2026-08-03T18:29:59Z')).toISOString()).toBe('2026-08-03T00:00:00.000Z');
    });

    it('the instant of IST midnight itself starts the new day', () => {
      // 2026-08-03T18:30:00Z == 2026-08-04 00:00:00 IST
      expect(istDate(new Date('2026-08-03T18:30:00Z')).toISOString()).toBe('2026-08-04T00:00:00.000Z');
    });

    it('is stable across a UTC month boundary that IST has already crossed', () => {
      // 2026-07-31T19:00:00Z == 2026-08-01 00:30 IST — UTC still says July, IST says August.
      expect(istDate(new Date('2026-07-31T19:00:00Z')).toISOString()).toBe('2026-08-01T00:00:00.000Z');
    });

    it('is stable across a UTC year boundary that IST has already crossed', () => {
      // 2026-12-31T19:00:00Z == 2027-01-01 00:30 IST
      expect(istDate(new Date('2026-12-31T19:00:00Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z');
    });

    it('is idempotent — feeding its own output back returns the same date', () => {
      const once = istDate(new Date('2026-08-03T20:30:00Z'));
      expect(istDate(once).toISOString()).toBe(once.toISOString());
    });
  });

  describe('istDayStartInstant — for @db.Timestamptz columns', () => {
    it('returns the real instant of IST midnight, 5h30m before the DATE form', () => {
      expect(istDayStartInstant(new Date('2026-08-04T09:00:00Z')).toISOString()).toBe('2026-08-03T18:30:00.000Z');
    });

    it('agrees with istDate on which IST day it is', () => {
      const now = new Date('2026-08-03T20:30:00Z'); // 02:00 IST on the 4th
      const diff = istDate(now).getTime() - istDayStartInstant(now).getTime();
      expect(diff).toBe(IST_OFFSET_MS);
    });

    it('a removal at 01:00 IST falls INSIDE that IST day, not the previous one', () => {
      // The me-tickets "removed today" window: removedAt >= istDayStartInstant(now).
      const now = new Date('2026-08-03T20:30:00Z'); // 02:00 IST on the 4th
      const removedAt = new Date('2026-08-03T19:30:00Z'); // 01:00 IST on the 4th
      expect(removedAt.getTime()).toBeGreaterThanOrEqual(istDayStartInstant(now).getTime());
    });

    it('a removal at 23:00 IST the previous evening falls OUTSIDE the current IST day', () => {
      const now = new Date('2026-08-03T20:30:00Z'); // 02:00 IST on the 4th
      const removedAt = new Date('2026-08-03T17:30:00Z'); // 23:00 IST on the 3rd
      expect(removedAt.getTime()).toBeLessThan(istDayStartInstant(now).getTime());
    });
  });

  /**
   * B8 — the leave/availability window parsers. `leave_requests.window_*` and `se_availability.window_*`
   * are `@db.Timestamptz` (real instants) and the active-window predicate is
   * `windowStart <= now AND windowEnd > now` (`se-availability.service.ts:45,73`) — **end-exclusive**.
   * So an SE who names a single IST calendar day must get `[IST midnight of it, IST midnight of the next)`.
   */
  describe('istWindowStart / istWindowEnd — date-only means an IST calendar day', () => {
    it('THE B8 REGRESSION: a date-only start is IST midnight, not UTC midnight', () => {
      // `new Date('2026-08-10')` yields 2026-08-10T00:00Z = 05:30 IST, leaving the SE bookable for
      // the first 5h30m of the day they booked off.
      expect(istWindowStart('2026-08-10').toISOString()).toBe('2026-08-09T18:30:00.000Z');
    });

    it('a date-only end is the NEXT IST midnight, so the named day is fully covered', () => {
      expect(istWindowEnd('2026-08-10').toISOString()).toBe('2026-08-10T18:30:00.000Z');
    });

    it('a single-day leave covers 00:15 and 23:45 IST of that day and stops at the next midnight', () => {
      const start = istWindowStart('2026-08-10').getTime();
      const end = istWindowEnd('2026-08-10').getTime();
      const at = (iso: string) => new Date(iso).getTime();
      const active = (t: number) => start <= t && end > t; // the service's own predicate

      expect(active(at('2026-08-09T18:45:00Z'))).toBe(true); // 00:15 IST on the 10th
      expect(active(at('2026-08-10T18:15:00Z'))).toBe(true); // 23:45 IST on the 10th
      expect(active(at('2026-08-10T18:45:00Z'))).toBe(false); // 00:15 IST on the 11th
      expect(active(at('2026-08-09T18:15:00Z'))).toBe(false); // 23:45 IST on the 9th
    });

    it('a multi-day range covers every IST day inclusive of the end date', () => {
      const start = istWindowStart('2026-08-10').getTime();
      const end = istWindowEnd('2026-08-12').getTime();
      const at = (iso: string) => new Date(iso).getTime();
      expect(start <= at('2026-08-11T18:45:00Z') && end > at('2026-08-11T18:45:00Z')).toBe(true); // 00:15 IST 12th
      expect(end).toBe(at('2026-08-12T18:30:00Z')); // stops at IST midnight opening the 13th
    });

    it('leaves a full ISO instant alone — admin sends `datetime-local` converted to UTC', () => {
      // SeManagementPage.tsx:89 does `new Date(value).toISOString()`; that is a real instant and must
      // NOT be re-read as an IST calendar day.
      expect(istWindowStart('2026-08-10T09:00:00.000Z').toISOString()).toBe('2026-08-10T09:00:00.000Z');
      expect(istWindowEnd('2026-08-10T17:00:00.000Z').toISOString()).toBe('2026-08-10T17:00:00.000Z');
    });

    it('leaves an instant that happens to be UTC midnight alone (the Z is explicit intent)', () => {
      expect(istWindowStart('2026-08-10T00:00:00Z').toISOString()).toBe('2026-08-10T00:00:00.000Z');
    });

    it('is Invalid Date for garbage, so callers keep emitting their INVALID_WINDOW 400', () => {
      expect(Number.isNaN(istWindowStart('not-a-date').getTime())).toBe(true);
      expect(Number.isNaN(istWindowEnd('').getTime())).toBe(true);
    });

    it('rejects a date-only value whose day does not exist rather than rolling it over', () => {
      // `Date.UTC(2026, 1, 31)` would silently become 3 March; the old `new Date('2026-02-31')` was
      // Invalid Date, and that 400 must survive.
      expect(Number.isNaN(istWindowStart('2026-02-31').getTime())).toBe(true);
      expect(Number.isNaN(istWindowStart('2026-13-01').getTime())).toBe(true);
    });

    it('a date-only range crossing a month end still orders correctly', () => {
      expect(istWindowStart('2026-08-31').toISOString()).toBe('2026-08-30T18:30:00.000Z');
      expect(istWindowEnd('2026-08-31').toISOString()).toBe('2026-08-31T18:30:00.000Z');
    });
  });
});
