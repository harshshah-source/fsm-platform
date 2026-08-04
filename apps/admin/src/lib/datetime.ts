// Absolute date-time presentation shared across surfaces, kept beside `inactiveDuration.ts` and for the
// same reason: so one timestamp reads identically everywhere it appears.

/**
 * The operating day is the `Asia/Kolkata` calendar day (CONTEXT.md Decisions §19, #204) — the same
 * boundary the backend buckets on (`apps/backend/src/common/ist-day.ts`). Anything that asks the
 * backend "which day is it" must derive the date this way and **not** from the operator's machine
 * clock: a device-local `getFullYear/getMonth/getDate` agrees with the backend only when the machine
 * happens to be set to IST, and disagrees for every request made between 00:00 and 05:29 IST.
 *
 * IST is a fixed +05:30 offset (India has never observed DST), so shifting the instant and reading the
 * UTC fields is exact — and, unlike `toLocaleDateString`, independent of the browser's own zone.
 */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/** `YYYY-MM-DD` for the IST calendar date containing `at` (default: now). */
export function istIsoDate(at: Date = new Date()): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * `YYYY-MM-DD` `days` whole calendar days after `iso`. Pure UTC arithmetic on a UTC-midnight anchor,
 * so it never round-trips through a local zone and cannot lose or gain a day at a DST edge.
 */
export function addIsoDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The IST calendar date a leave/availability `windowStart` instant falls on (#204 finding B7, which
 * went live the moment #204 moved the boundary). These windows are stored as the real instants
 * bounding the IST days they cover — 10 Aug is `2026-08-09T18:30Z` — so `iso.slice(0, 10)`, which is
 * what `LeaveRequestsPage` and `SeManagementPage` both did, renders a start one day early. Mirrored on
 * mobile in `leave/leaveDisplay.ts`.
 */
export function istWindowStartDate(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '—' : istIsoDate(new Date(t));
}

/**
 * The last IST day a `windowEnd` instant actually covers. The window is **end-exclusive**
 * (`se-availability.service.ts:45,73`), so a date-only leave through 12 Aug ends at `2026-08-12T18:30Z`
 * — IST midnight *opening* the 13th. Stepping back one millisecond lands on the last covered day, and
 * leaves a mid-day manager-set end (`datetime-local`) on its own day.
 */
export function istWindowEndDate(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '—' : istIsoDate(new Date(t - 1));
}

/**
 * Absolute timestamp with the year, e.g. `13 Jul 2026, 08:36`. Rendered in the viewer's local zone from
 * the UTC ISO string the API returns.
 *
 * The year is the point of this helper — `pages/dispatch/format.ts` has a deliberately year-less
 * `formatDateTime` for run times, which are always recent. Trip-creation stamps span 2023→2026 on the
 * live source, so dropping the year there would read as a recent trip. Returns `—` for null/unparseable
 * (a device with no trip yet, or a backend predating the field).
 */
export function formatDateTimeWithYear(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
