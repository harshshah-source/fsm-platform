import { describe, expect, it } from 'vitest';
import { istDate, istDayStartInstant, IST_OFFSET_MS } from '../src/common/ist-day';

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
});
