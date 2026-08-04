/**
 * The operating day — `Asia/Kolkata`, midnight to midnight (CONTEXT.md Decisions §19, ruled on #198
 * 2026-08-04, implemented by #204). §19 is the authority; #198 carries the options and evidence.
 *
 * Replaces `utc-day.ts`, which bucketed days at **UTC** midnight — 05:30 IST — so everything a field
 * engineer did between midnight and 05:29 IST was filed under the previous calendar day, in the Day
 * Plan and in every report. That was never a decision: `utcDayStart` was consolidated as a refactor
 * side-effect (#146 slice 3) and ~15 services inherited it.
 *
 * **Two values, deliberately separate — do not conflate them.** They differ by exactly 5h30m, so
 * passing one where the other belongs shifts a window by that much and nothing fails loudly:
 *
 * | Use for | Function | Because |
 * |---|---|---|
 * | `@db.Date` columns (`deferred_until`, `deferred_to_date`, `date_from`, `date_to`) | {@link istDate} | Postgres `DATE` carries no timezone; Prisma marshals it to/from **UTC midnight**, so the comparison value must be UTC midnight *of the IST calendar date* |
 * | `@db.Timestamptz` columns (`removed_at`) | {@link istDayStartInstant} | These are real instants, so the boundary must be the real instant IST midnight occurred |
 *
 * {@link istWindowStart} / {@link istWindowEnd} are the third pair, for the *request* side: a caller who
 * names a bare `YYYY-MM-DD` means an IST calendar day, and the end-exclusive window predicate means the
 * end date has to resolve to the *next* IST midnight for that day to be covered at all.
 *
 * IST is a fixed **+05:30** offset: India has never observed daylight saving, and the offset has been
 * unchanged since 1947. A fixed constant is therefore exact in perpetuity and avoids an `Intl`
 * round-trip on paths the recommender calls per run — but it is asserted in `ist-day.spec.ts` rather
 * than assumed, so the assumption is pinned rather than folklore.
 */
export const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/**
 * UTC midnight of the IST calendar date containing `now` — the value every `@db.Date` comparison
 * wants. Idempotent: feeding its own output back returns the same date.
 */
export function istDate(now: Date): Date {
  const shifted = new Date(now.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
}

/**
 * The instant at which the current IST day began (UTC 18:30 the previous day) — the value every
 * `@db.Timestamptz` comparison wants.
 */
export function istDayStartInstant(now: Date): Date {
  return new Date(istDate(now).getTime() - IST_OFFSET_MS);
}

/** A bare calendar date with no time part — the shape the mobile leave form sends. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * IST midnight `dayOffset` days after the given `YYYY-MM-DD`, as a real instant. Returns Invalid Date
 * for a date that does not exist (`2026-02-31`, `2026-13-01`) rather than letting `Date.UTC` roll it
 * over silently — `new Date('2026-02-31')` was Invalid Date, and the 400 that produced must survive.
 */
function istMidnightOfCalendarDate(value: string, dayOffset: number): Date {
  const [y, m, d] = value.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    return new Date(NaN);
  }
  return new Date(Date.UTC(y, m - 1, d + dayOffset) - IST_OFFSET_MS);
}

/**
 * Parse a `window_start` request value (#204 finding B8).
 *
 * `leave_requests.window_start/window_end` and `se_availability.window_start/window_end` are
 * `@db.Timestamptz` — real instants — and the active-window predicate is
 * `windowStart <= now AND windowEnd > now` (`se-availability.service.ts:45,73`), i.e. **end-exclusive**.
 * A caller naming a bare `YYYY-MM-DD` means an IST calendar day, so the pair maps to
 * `[IST midnight of the start date, IST midnight of the day after the end date)` — see {@link istWindowEnd}.
 *
 * Anything else is passed to `new Date` verbatim: admin sends `datetime-local` values already converted
 * with `toISOString()` (`SeManagementPage.tsx:89`), which are real instants and must **not** be re-read
 * as IST calendar days. Invalid input stays Invalid Date so callers keep emitting their own 400.
 */
export function istWindowStart(value: string): Date {
  const raw = String(value ?? '').trim(); // controllers hand this straight off an unvalidated JSON body
  return DATE_ONLY.test(raw) ? istMidnightOfCalendarDate(raw, 0) : new Date(raw);
}

/**
 * Parse a `window_end` request value — the mirror of {@link istWindowStart}, except that a date-only
 * value resolves to IST midnight of the **next** date. The predicate is end-exclusive, so that is what
 * makes the named day itself covered: `2026-08-10`→`2026-08-10T18:30Z`, which is 00:00 IST on the 11th.
 */
export function istWindowEnd(value: string): Date {
  const raw = String(value ?? '').trim(); // controllers hand this straight off an unvalidated JSON body
  return DATE_ONLY.test(raw) ? istMidnightOfCalendarDate(raw, 1) : new Date(raw);
}
