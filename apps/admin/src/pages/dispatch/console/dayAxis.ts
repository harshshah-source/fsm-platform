/**
 * **The board's day axis** (composition correction §6, approved 2026-08-28 — decision D9).
 *
 * The Console is date-navigable, but `GET /dispatch/today` is **never given a date** — it stays
 * `istDate(now)` on the server, and the Console picks a *source* by semantic state instead of
 * teaching an endpoint to lie:
 *
 * - a **past** day answers from `GET /schedules?date=` — committed counts, immutable, past tense;
 * - **today** answers from the one lifted `GET /dispatch/today` payload — everything, mutable;
 * - a **future** day answers from `GET /schedules?date=` (committed plans, where they exist) and
 *   `GET /schedules/preview?date=` (the projection) — conditional mood, "would be assigned".
 *
 * Everything here is pure calendar math over the IST operating-day strings (`YYYY-MM-DD`) the
 * backend already publishes. No `new Date()` reading of the browser clock: the server's
 * `operatingDay` is the only authority on which day is "today", because the operator's browser may
 * sit in any timezone while the operating day is an IST fact.
 */

export type DaySemantic = 'past' | 'today' | 'future';

/** How many context columns surround the focused day: `day` = one either side, `week` = three. */
export type Span = 'day' | 'week';

/** `2026-08-28` + n days, as calendar math in UTC so DST/locale can never shift the day. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function semanticOf(day: string, today: string): DaySemantic {
  if (day === today) return 'today';
  return day < today ? 'past' : 'future';
}

/**
 * The visible columns, oldest first. The focused day is always among them; `TODAY` is always one
 * click away in the top bar regardless of what is visible.
 */
export function visibleDays(focused: string, span: Span): string[] {
  const reach = span === 'week' ? 3 : 1;
  const days: string[] = [];
  for (let n = -reach; n <= reach; n++) days.push(addDays(focused, n));
  return days;
}

/** `Thu 28 Aug` — the column heading. UTC rendering so the label matches the IST day string. */
export function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

/** A valid `?day=` param, or null — a malformed value degrades to "today", never to a throw. */
export function parseDayParam(raw: string | null): string | null {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return raw;
}
