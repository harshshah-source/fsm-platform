import { describe, expect, it } from 'vitest';
import { CRON_TICK_CLAIM_RETENTION_DAYS, tickWindowStart } from '../src/scheduling/cron-tick-claim';

/**
 * #263 — the window a cron fire belongs to.
 *
 * Two instances never fire the same job at the identical millisecond, so "did somebody already run
 * this tick?" has to be asked about a *bucket*, not an instant. The bucket is the UTC minute: every
 * cron in this app fires at minute granularity at most, so one minute is the finest bucket that can
 * never split a single logical fire in two, and the coarsest that can never merge two.
 *
 * There is no timezone here on purpose. `BUSINESS_TIMEZONE`-pinned jobs (#240) decide *when* a tick
 * fires; by the time it has fired the only thing that matters is the instant, and an instant has no
 * timezone. That is also why DST is irrelevant to this function — it truncates epoch milliseconds.
 */
describe('#263 — cron tick window derivation', () => {
  it('truncates a fire instant to the start of its UTC minute', () => {
    expect(tickWindowStart(new Date('2026-08-23T05:00:37.412Z')).toISOString()).toBe('2026-08-23T05:00:00.000Z');
  });

  it('is idempotent — a window start is its own window', () => {
    const w = tickWindowStart(new Date('2026-08-23T05:00:37.412Z'));
    expect(tickWindowStart(w).getTime()).toBe(w.getTime());
  });

  it('puts two instants in the same minute in the same window, and the next second-boundary out', () => {
    const early = tickWindowStart(new Date('2026-08-23T05:00:00.001Z'));
    const late = tickWindowStart(new Date('2026-08-23T05:00:59.999Z'));
    const next = tickWindowStart(new Date('2026-08-23T05:01:00.000Z'));
    expect(early.getTime()).toBe(late.getTime());
    expect(next.getTime()).toBe(early.getTime() + 60_000);
  });

  it('crosses a DST boundary without a seam — the windows are 60s apart on the epoch, not on a clock', () => {
    // 2026-03-29 01:00 UTC is the instant Europe shifts; IST does not observe DST at all. Either way
    // the function never consults a calendar, so the two windows stay exactly one minute apart.
    const before = tickWindowStart(new Date('2026-03-29T00:59:30.000Z'));
    const after = tickWindowStart(new Date('2026-03-29T01:00:30.000Z'));
    expect(after.getTime() - before.getTime()).toBe(60_000);
  });

  it('keeps the retention horizon a single stated constant', () => {
    expect(CRON_TICK_CLAIM_RETENTION_DAYS).toBe(7);
  });
});
