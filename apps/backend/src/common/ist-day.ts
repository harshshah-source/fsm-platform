/**
 * The operating day — `Asia/Kolkata`, midnight to midnight (CONTEXT.md Decisions §19, ruled
 * 2026-08-04, implemented by #204).
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
