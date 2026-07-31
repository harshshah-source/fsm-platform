// Presentation helpers shared by every surface that reports fleet counts — the KPI cards, the Zone and
// Company overviews, the Fleet Directory and the Fleet Composition funnel. One place, so the same
// figure never reads two ways across two tables.

const nf = new Intl.NumberFormat('en-IN');

/** A device count, Indian digit grouping (`17,415`). */
export function formatCount(n: number | null | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? nf.format(n) : '—';
}

/**
 * A rate already computed by the backend against the OPERATIONAL denominator. One decimal.
 *
 * Renders `—`, never `0.0%`, for null: null means "this entity has no operational devices", which is
 * a different statement from "0% of them are inactive" and must not read as a clean bill of health.
 */
export function formatPct(pct: number | null | undefined): string {
  return typeof pct === 'number' && Number.isFinite(pct) ? `${pct.toFixed(1)}%` : '—';
}

/**
 * An absolute freshness stamp for a data source — `29 Jul 2026, 11:19 AM`. Twelve-hour with the year,
 * because these appear beside a KPI where "is this number from today?" is the question being asked.
 * Local zone, from the UTC ISO the API returns; `—` for null/unparseable.
 */
export function formatStamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * `inactive / operational` as one string — the Inactive Operational cell, e.g. `137 / 486`. The
 * denominator is the operational fleet, never the mirrored total; a null denominator degrades to `—`
 * rather than rendering a bare numerator that looks like a total.
 */
export function formatInactiveOfOperational(inactive: number, operational: number | null | undefined): string {
  return `${formatCount(inactive)} / ${formatCount(operational)}`;
}
