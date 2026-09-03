import { useMemo } from 'react';
import { Bar, BarChart, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartTooltip } from './ChartTooltip';
import { CHART } from './colors';
import { formatValue, type ValueFormat } from './format';

export interface BarDatum {
  name: string;
  value: number;
  color?: string;
}

/** Row geometry — one bar plus its breathing room. Drives the derived height. */
const ROW_HEIGHT = 30;
const CHART_PADDING = 16;

/**
 * Ranked horizontal bar chart ("Inactivity by SLA bucket", "Fleet Uptime % by zone", root-cause
 * distribution, auto-dispatch by zone).
 *
 * The bars carry their value DIRECTLY at the end of each bar rather than against a value axis. For a
 * ranked comparison of a handful of named categories that is the stronger reading: the eye compares
 * bar lengths for the ordering and reads the exact figure off the label, with no second trip to an
 * axis and no hover. It also fixes the previous shape, which hid the X axis (`<XAxis hide />`) while
 * leaving the numbers reachable only through a tooltip — six report panels where the values were
 * effectively invisible.
 *
 * Height derives from the row count so an 8-bucket panel is not cramped into the same box as a
 * 3-zone one; pass `height` to pin it.
 *
 * `sort` defaults to preserving caller order, because several call sites are ORDINAL — the SLA
 * buckets are a severity ramp and the device-detail bars are chronological. Re-sorting those by
 * value would destroy the axis's meaning. Rank-ordered call sites opt in with `sort="desc"`.
 */
export function BarChartCard({
  data,
  height,
  color = CHART.brand,
  categoryWidth = 120,
  format = 'count',
  sort = 'none',
}: {
  data: BarDatum[];
  height?: number;
  color?: string;
  categoryWidth?: number;
  /** How the values read — `percent` appends `%` to labels and tooltip. */
  format?: ValueFormat;
  /** `desc` ranks largest-first. Leave as `none` when the category order carries meaning. */
  sort?: 'none' | 'desc' | 'asc';
}) {
  const rows = useMemo(() => {
    if (sort === 'none') return data;
    const copy = [...data];
    copy.sort((a, b) => (sort === 'desc' ? b.value - a.value : a.value - b.value));
    return copy;
  }, [data, sort]);

  const resolvedHeight = height ?? Math.max(120, rows.length * ROW_HEIGHT + CHART_PADDING);

  // Headroom for the direct labels: the longest rendered label, converted to a rough pixel width at
  // the 11px label size. Without it the widest bar's label clips at the plot edge.
  const labelGutter = useMemo(() => {
    const longest = rows.reduce(
      (max, d) => Math.max(max, formatValue(d.value, format).length),
      0,
    );
    return Math.max(28, longest * 7 + 10);
  }, [rows, format]);

  return (
    <div style={{ height: resolvedHeight }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          layout="vertical"
          data={rows}
          margin={{ top: 4, right: labelGutter, bottom: 4, left: 4 }}
        >
          {/* The value axis stays hidden — the direct labels ARE the scale here — but the domain is
              pinned to the data so bar lengths remain proportional to value. */}
          <XAxis type="number" hide domain={[0, 'dataMax']} />
          <YAxis
            type="category"
            dataKey="name"
            width={categoryWidth}
            tick={{ fontSize: 11, fill: CHART.axis }}
            axisLine={false}
            tickLine={false}
            interval={0}
          />
          <Tooltip
            cursor={{ fill: 'var(--color-surface-sunken)', fillOpacity: 0.55 }}
            content={<ChartTooltip format={format} />}
          />
          <Bar dataKey="value" radius={[0, 4, 4, 0]} barSize={14} isAnimationActive={false}>
            {rows.map((d, i) => (
              <Cell key={`${d.name}-${i}`} fill={d.color ?? color} />
            ))}
            <LabelList
              dataKey="value"
              position="right"
              offset={8}
              formatter={(v: number) => formatValue(v, format)}
              style={{
                fontSize: 11,
                fontWeight: 600,
                fill: 'var(--color-ink-strong)',
                fontVariantNumeric: 'tabular-nums',
              }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
