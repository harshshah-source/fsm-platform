// Absolute date-time presentation shared across surfaces, kept beside `inactiveDuration.ts` and for the
// same reason: so one timestamp reads identically everywhere it appears.

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
