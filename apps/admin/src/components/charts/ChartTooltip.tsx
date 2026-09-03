import { formatShare, formatValue, type ValueFormat } from './format';

/**
 * One series' entry as recharts hands it to a custom tooltip. Typed loosely on purpose: the shape
 * differs slightly between Line, Bar and Pie, and every field we read is optional in at least one
 * of them.
 */
export interface TooltipPayloadEntry {
  name?: string | number;
  value?: number | string;
  color?: string;
  /** Line series report their colour here rather than on `color`. */
  stroke?: string;
  fill?: string;
  dataKey?: string | number;
  payload?: Record<string, unknown>;
}

export interface ChartTooltipProps {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: string | number;
  /** How the series' numbers should read. */
  format?: ValueFormat;
  /**
   * Rewrites the heading — e.g. a raw bucket key into "15 Aug 2026". Receives the first payload
   * entry too, so a caller can reach a field carried on the datum (the un-truncated bucket, say)
   * rather than the abbreviated string the axis shows.
   */
  labelFormat?: (label: string, entry?: TooltipPayloadEntry) => string;
  /** Adds a summed footer row. Only meaningful when the series are additive. */
  showTotal?: boolean;
  /**
   * Restricts the total to these dataKeys. Needed whenever a chart mixes series that are not
   * mutually additive — the activity trend overlays a device STOCK on two ticket FLOWS, and adding
   * all three yields a number that corresponds to nothing. With this set, the total (and any share)
   * covers only the additive series.
   */
  totalKeys?: string[];
  /** Overrides the footer row's label, e.g. "Tickets created" instead of a bare "Total". */
  totalLabel?: string;
  /** Adds each row's share of the tooltip total — for composition charts (donut, stacked). */
  showShare?: boolean;
  /** Renders under the rows, e.g. a caveat or a unit note. */
  hint?: string;
  /**
   * Drops rows whose value is 0. For a composition tooltip (a stacked bar with eight SLA buckets,
   * most of them empty for a healthy zone) the zeroes are pure noise and push the rows that matter
   * off the bottom. The total is still computed over every row, so nothing is lost.
   */
  hideZeroRows?: boolean;
}

/**
 * The shared chart tooltip — a dark pill, matching the reference's value chip.
 *
 * Every recharts chart in the app uses this instead of the library default. The default renders a
 * hard-coded white panel that glares on the pitch-black canvas (there is no token behind it to
 * re-point), and it prints the raw `dataKey` — a viewer reading "Fleet Uptime %" got `value : 98.2`,
 * with neither the unit nor the series' real name.
 *
 * `bg-chrome-900` is the one surface token that stays near-black in BOTH themes (it is the sidebar /
 * footer rail), which is why the pill can carry fixed white text and still meet contrast either way.
 */
export function ChartTooltip({
  active,
  payload,
  label,
  format = 'count',
  labelFormat,
  showTotal = false,
  totalKeys,
  totalLabel = 'Total',
  showShare = false,
  hint,
  hideZeroRows = false,
}: ChartTooltipProps) {
  if (!active || !payload?.length) return null;

  const all = payload.filter((p) => typeof p.value === 'number');
  if (!all.length) return null;

  // Total spans every row it covers, including any the display drops — a share must be a share of
  // the whole, not of what happened to remain visible.
  const summed = totalKeys ? all.filter((p) => totalKeys.includes(String(p.dataKey))) : all;
  const total = summed.reduce((sum, p) => sum + (p.value as number), 0);
  const rows = hideZeroRows ? all.filter((p) => (p.value as number) !== 0) : all;
  if (!rows.length) return null;
  const heading =
    label == null ? null : labelFormat ? labelFormat(String(label), rows[0]) : String(label);

  return (
    <div className="pointer-events-none rounded-lg bg-chrome-900 px-3 py-2 text-xs text-white shadow-floating ring-1 ring-white/10">
      {heading && <div className="mb-1.5 font-semibold">{heading}</div>}

      <div className="space-y-0.5">
        {rows.map((p, i) => (
          <div key={`${p.dataKey ?? p.name ?? i}`} className="flex items-center gap-3">
            <span
              aria-hidden
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: p.color ?? p.stroke ?? p.fill ?? 'currentColor' }}
            />
            <span className="mr-auto text-white/70">{p.name ?? p.dataKey}</span>
            <span className="font-semibold tabular-nums">
              {formatValue(p.value as number, format)}
            </span>
            {showShare && (
              <span className="w-9 shrink-0 text-right tabular-nums text-white/50">
                {formatShare(p.value as number, total)}
              </span>
            )}
          </div>
        ))}
      </div>

      {showTotal && summed.length > 1 && (
        <div className="mt-1.5 flex items-center gap-3 border-t border-white/15 pt-1.5">
          <span aria-hidden className="h-2 w-2 shrink-0" />
          <span className="mr-auto text-white/70">{totalLabel}</span>
          <span className="font-bold tabular-nums">{formatValue(total, format)}</span>
          {showShare && <span className="w-9 shrink-0" />}
        </div>
      )}

      {hint && <div className="mt-1.5 text-[10px] text-white/40">{hint}</div>}
    </div>
  );
}
