import type { VehicleUnavailReason } from '@fsm/shared';

/** e.g. `VEHICLE_ON_TRIP` -> "Vehicle On Trip". */
export function formatReasonLabel(reason: VehicleUnavailReason): string {
  return reason
    .split('_')
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(' ');
}

/** IST is a fixed +05:30 and has been since 1947 — the same constant the backend's `ist-day.ts` pins. */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const TIME_ONLY = /^\d{2}:\d{2}$/;

/**
 * Turn the SE's typed return date (+ optional time) into the instant to send — read as **IST**, not
 * as the handset's timezone (#246).
 *
 * Two reasons it is anchored explicitly rather than left to `new Date('2026-06-27T14:00')`. The
 * server buckets deferrals by IST calendar day, so a handset on any other clock would produce a date
 * that means a different operating day than the one the SE picked; and a bare `YYYY-MM-DD` parsed by
 * `Date` is UTC midnight, which is 05:30 IST — the same off-by-a-few-hours class of bug `ist-day.ts`
 * exists to end on the backend.
 *
 * Returns `null` for anything malformed, including dates that do not exist (`2026-02-31`) — the
 * server is authoritative on rejection, but there is no reason to send it a value we can already see
 * is not a date.
 */
export function istInstantFromEntry(date: string, time?: string): string | null {
  const day = (date ?? '').trim();
  if (!DATE_ONLY.test(day)) return null;

  const clock = (time ?? '').trim();
  let hours = 0;
  let minutes = 0;
  if (clock !== '') {
    if (!TIME_ONLY.test(clock)) return null;
    [hours, minutes] = clock.split(':').map(Number);
    if (hours > 23 || minutes > 59) return null;
  }

  const [y, m, d] = day.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  // `Date.UTC` rolls 2026-02-31 forward to 2026-03-03 rather than failing; catch it by reading back.
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;

  return new Date(Date.UTC(y, m - 1, d, hours, minutes) - IST_OFFSET_MS).toISOString();
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Render the IST calendar day the **server** decided this ticket waits for. The value arrives as UTC
 * midnight of that IST date (`deferred_until` is a `@db.Date`), so it is read back in UTC — shifting
 * it into local time would move it a day on any handset west of IST.
 *
 * `null` in means there is no wait at all, and the caller should say so rather than print a date.
 */
export function formatReturnDay(deferredUntil: string | null): string | null {
  if (!deferredUntil) return null;
  const d = new Date(deferredUntil);
  if (Number.isNaN(d.getTime())) return null;
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
