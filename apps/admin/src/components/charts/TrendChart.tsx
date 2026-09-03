import { useMemo } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceDot, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartTooltip } from './ChartTooltip';
import { CHART } from './colors';
import { formatTick, formatValue, niceStep, type ValueFormat } from './format';

/** Ticks on a fitted Y axis, including both endpoints. */
const FITTED_TICKS = 5;

export interface TrendDatum {
  label: string;
  /**
   * `null` is a **gap**, not a zero (#346). The month (or bucket) keeps its place on the X axis and
   * the line breaks over it — recharts leaves a null point unplotted, which is the only rendering
   * that says "we do not know" rather than inventing a value. Dropping the point instead would
   * silently relabel the axis; plotting a `0` or a `100` would invent a catastrophe or a perfect month.
   */
  value: number | null;
}

/**
 * Single-series trend over time (fleet uptime, soft-inactive stock, cohort time-to-online).
 *
 * Two things the previous shape got wrong, both about reading a value off the line:
 *
 * 1. The Y axis was always anchored at zero. For "Fleet Uptime % — last 6 months", whose real spread
 *    is roughly 97–99%, that compressed every month into the top 3% of the plot and drew what looked
 *    like a flat line — the one question the panel exists to answer (is uptime moving?) was the one
 *    it could not show. `zeroBaseline={false}` fits the axis to the data instead. It stays opt-OUT
 *    because for a COUNT series a non-zero baseline exaggerates change, which is the opposite error.
 * 2. The tooltip was the recharts default, so it read `value : 98.2` — no unit, no series name.
 *
 * The latest point is also labelled directly, since "where is it now" is the first thing read off a
 * trend and it should not require a hover.
 */
export function TrendChart({
  data,
  height = 240,
  color = CHART.brand,
  format = 'count',
  seriesName = 'Value',
  zeroBaseline = true,
  showLatest = true,
}: {
  data: TrendDatum[];
  height?: number;
  color?: string;
  /** How the values read — `percent` appends `%` everywhere. */
  format?: ValueFormat;
  /** Series name shown in the tooltip, in place of the raw `value` key. */
  seriesName?: string;
  /** Anchor the Y axis at zero. Turn OFF for a tightly-clustered series such as uptime %. */
  zeroBaseline?: boolean;
  /** Label the most recent point directly. */
  showLatest?: boolean;
}) {
  /**
   * A fitted domain, padded by a tenth of the spread. Falls back to a zero baseline when the series
   * is flat or empty (a zero-spread domain renders nothing).
   *
   * Two things the first cut got wrong, both caught rendering real Fleet Uptime data:
   *
   * 1. **The upper bound was unbounded.** Padding a series that reaches 100% and ceiling it produced
   *    a `105%` gridline — an impossible uptime, presented as if it were a reachable value. A
   *    percentage is clamped to 0–100 here regardless of padding.
   * 2. **The bounds were rounded but the STEP was not**, so a 51→105 domain split five ways landed
   *    on 13.5-unit ticks that, with decimals suppressed, rendered as `51 / 66 / 81 / 105` — two
   *    different gap sizes on one axis. The step is now a round number and the lower bound is
   *    derived from it, so every gap is identical.
   */
  const domain = useMemo<[number | 'auto', number | 'auto']>(() => {
    if (zeroBaseline) return [0, 'auto'];
    const values = data.map((d) => d.value).filter((v): v is number => v !== null && Number.isFinite(v));
    if (values.length < 2) return [0, 'auto'];
    const min = Math.min(...values);
    const max = Math.max(...values);
    if (min === max) return [0, 'auto'];

    const pad = (max - min) * 0.1;
    const ceiling = format === 'percent' ? Math.min(100, max + pad) : max + pad;
    const floor = Math.max(format === 'percent' ? 0 : -Infinity, min - pad);

    const step = niceStep((ceiling - floor) / (FITTED_TICKS - 1));
    const hi = Math.min(
      format === 'percent' ? 100 : Infinity,
      Math.ceil(ceiling / step) * step,
    );
    const lo = Math.max(format === 'percent' ? 0 : -Infinity, hi - step * (FITTED_TICKS - 1));
    return [lo, hi];
  }, [data, zeroBaseline, format]);

  /**
   * The direct label goes on the last point that HAS a value, not the last point. A trailing gap (a
   * month the cube has not computed yet) would otherwise put a `null` on the ReferenceDot and either
   * drop the label or draw it at the axis floor.
   */
  const latest = useMemo(() => {
    if (!showLatest) return null;
    for (let i = data.length - 1; i >= 0; i--) {
      const d = data[i];
      if (d && d.value !== null && Number.isFinite(d.value)) return { label: d.label, value: d.value };
    }
    return null;
  }, [data, showLatest]);

  // Drives whole-axis compaction, so the ticks cannot switch notation partway down the scale.
  const axisMax = useMemo(
    () => data.reduce((max, d) => (d.value !== null && Number.isFinite(d.value) ? Math.max(max, d.value) : max), 0),
    [data],
  );

  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        {/* Right margin holds the latest-value label; without it the label clips at the plot edge. */}
        <LineChart data={data} margin={{ top: 12, right: latest ? 52 : 16, bottom: 4, left: -4 }}>
          <CartesianGrid stroke={CHART.grid} vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 11, fill: CHART.axis }}
            axisLine={false}
            tickLine={false}
            minTickGap={24}
          />
          <YAxis
            tick={{ fontSize: 11, fill: CHART.axis }}
            axisLine={false}
            tickLine={false}
            width={44}
            domain={domain}
            // A fitted domain carries its own even step, so pin the count that step was built for.
            {...(zeroBaseline ? {} : { tickCount: FITTED_TICKS, interval: 0 as const })}
            tickFormatter={(v: number) => formatTick(v, format, axisMax)}
            // Only a genuinely fractional series (`decimal`) gets fractional ticks. A percent axis
            // renders whole numbers, so fractional ticks would collapse onto duplicate labels.
            allowDecimals={format === 'decimal'}
          />
          <Tooltip
            cursor={{ stroke: CHART.grid, strokeWidth: 1 }}
            content={<ChartTooltip format={format} />}
          />
          <Line
            name={seriesName}
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={2}
            dot={false}
            // #346 — explicit, because this is the behaviour the honesty fix depends on: a `null`
            // point BREAKS the line. It is already recharts' default, and a default is not a decision
            // record; someone reaching for `connectNulls` to "tidy up the chart" should see it named.
            connectNulls={false}
            // A single-point series draws no line segment and so would render as an empty plot.
            activeDot={{ r: 4, strokeWidth: 0 }}
            isAnimationActive={false}
          />
          {latest && (
            <ReferenceDot
              x={latest.label}
              y={latest.value}
              r={3.5}
              fill={color}
              stroke="var(--color-surface-card)"
              strokeWidth={2}
              isFront
              label={{
                value: formatValue(latest.value, format),
                position: 'right',
                offset: 8,
                fontSize: 11,
                fontWeight: 700,
                fill: 'var(--color-ink-strong)',
              }}
            />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
