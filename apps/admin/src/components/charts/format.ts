/**
 * Value formatting for charts.
 *
 * Every number a chart shows — tooltip, axis tick, direct bar label — routes through here, so a
 * series that is a percentage never renders as a bare `98.2` and a fleet count never renders as
 * `10758` where `10,758` was meant. The locale is `en-IN`, matching the grouping already pinned in
 * `SlaBucketBarChart` (Indian digit grouping: 10,758 → 1,07,58,000 at lakh/crore scale).
 *
 * This module is presentation only. It never rounds a value before it reaches the chart — the
 * underlying datum is untouched, only its rendered string changes.
 */

/** What a series' numbers MEAN, which is what decides how they render. */
export type ValueFormat =
  /** Whole things: devices, tickets, runs. Grouped, no decimals. */
  | 'count'
  /** Already-scaled percentage (98.2 → "98.2%"), not a 0–1 fraction. */
  | 'percent'
  /** A measured quantity that can carry a fraction — hours, days, ratios. */
  | 'decimal';

const groupedInt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** Full-precision rendering, for tooltips and direct labels. */
export function formatValue(value: number | null | undefined, format: ValueFormat = 'count'): string {
  if (value == null || !Number.isFinite(value)) return '—';

  switch (format) {
    case 'percent':
      // A whole percentage keeps no decimal point — "100%" reads better than "100.0%" — but a
      // fractional one keeps exactly one, so a column of them stays decimal-aligned.
      return Number.isInteger(value) ? `${groupedInt.format(value)}%` : `${oneDecimal.format(value)}%`;
    case 'decimal':
      return Number.isInteger(value) ? groupedInt.format(value) : oneDecimal.format(value);
    case 'count':
    default:
      return groupedInt.format(value);
  }
}

/**
 * Axis-tick rendering — the same value, shortened, because an axis has a fraction of the room a
 * tooltip has.
 *
 * `axisMax` is the largest value the axis will show, and it decides compaction for the WHOLE axis
 * rather than per tick. Deciding per tick produced a visibly incoherent scale — a soft-inactive axis
 * came out reading `14k / 10.5k / 7,000 / 3,500 / 0`, switching notation halfway down because only
 * the top two ticks cleared the threshold on their own. Pass it whenever the caller knows the
 * domain; omitted, it falls back to judging each tick alone.
 */
export function formatTick(value: number, format: ValueFormat = 'count', axisMax?: number): string {
  if (!Number.isFinite(value)) return '';
  // Percent ticks are always whole. Letting them carry a fraction meant a tight domain (uptime, 97
  // → 100) generated ticks 0.75 apart that all rounded to the same label — an axis reading
  // `100% / 99% / 99% / 98% / 97%`, with one step silently duplicated.
  if (format === 'percent') return `${groupedInt.format(Math.round(value))}%`;

  const scale = axisMax ?? Math.abs(value);
  if (format === 'count' && scale >= 10_000) {
    if (value === 0) return '0';
    // Deliberately not `notation: 'compact'`: that yields "1L"/"1Cr" under en-IN, which is correct
    // for the locale but unreadable on an axis a mixed-region ops team shares.
    return `${oneDecimal.format(value / 1000).replace(/\.0$/, '')}k`;
  }
  return groupedInt.format(value);
}

/** Tick steps that read as round numbers at any magnitude. */
const NICE_STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

/**
 * Smallest "round" number ≥ `v` — 32.5 → 40, 12.375 → 15. Use it to pick a tick STEP whenever an
 * axis domain is set explicitly, because recharts only chooses pleasant ticks for domains it derived
 * itself. Rounding the domain bounds alone is not enough: a domain of 51→105 split four ways gives
 * 13.5-unit steps, and suppressing decimals then renders the uneven `51 / 66 / 81 / 105` ladder this
 * exists to prevent.
 */
export function niceStep(v: number): number {
  if (v <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(v));
  const normalized = v / magnitude;
  return (NICE_STEPS.find((s) => s >= normalized) ?? 10) * magnitude;
}

/** `value` as a share of `total`, for composition tooltips. Guards a zero total. */
export function formatShare(value: number, total: number): string {
  if (!total) return '—';
  const pct = (100 * value) / total;
  // Anything that rounds to 0% but is not actually 0 gets "<1%", so a real slice never reads as empty.
  if (pct > 0 && pct < 0.5) return '<1%';
  return `${groupedInt.format(Math.round(pct))}%`;
}
