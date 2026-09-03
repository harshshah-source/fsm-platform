import type { ReactNode } from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { ChartTooltip } from './ChartTooltip';
import { CHART_PALETTE } from './colors';
import { formatShare, formatValue } from './format';

export interface DonutDatum {
  name: string;
  value: number;
  color?: string;
}

/**
 * Donut/proportion chart with an optional centre overlay (verification outcomes / workload).
 *
 * A donut answers "what is the mix", so the tooltip now carries the SHARE alongside the count — the
 * proportion is the whole reason to reach for this form, and reading it off the arc by eye is the
 * thing donuts are worst at. The recharts default tooltip showed neither the share nor a themed
 * surface.
 */
export function DonutChart({
  data,
  height = 220,
  center,
}: {
  data: DonutDatum[];
  height?: number;
  center?: ReactNode;
}) {
  const hasData = data.some((d) => d.value > 0);
  const total = data.reduce((sum, d) => sum + d.value, 0);

  return (
    <div className="relative" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            innerRadius="62%"
            outerRadius="88%"
            paddingAngle={2}
            stroke="none"
            isAnimationActive={false}
          >
            {data.map((d, i) => (
              <Cell key={i} fill={d.color ?? CHART_PALETTE[i % CHART_PALETTE.length]} />
            ))}
          </Pie>
          {/* A Pie tooltip carries only the hovered slice, so its payload total is that slice — the
              share has to be computed against the chart's own total, not the tooltip's. */}
          <Tooltip
            content={({ active, payload }) => (
              <ChartTooltip
                active={active}
                payload={payload?.map((p) => ({
                  name: p.name,
                  value: p.value as number,
                  color: (p.payload as { fill?: string } | undefined)?.fill,
                }))}
                format="count"
                hint={
                  payload?.length && typeof payload[0].value === 'number'
                    ? `${formatShare(payload[0].value, total)} of ${formatValue(total, 'count')}`
                    : undefined
                }
              />
            )}
          />
        </PieChart>
      </ResponsiveContainer>
      {/* The centre overlay and the empty-state message occupy the same absolutely-positioned box,
          so they must be mutually exclusive. Rendering both — which happened whenever a caller
          passed `center` and the window held no rows — superimposed "No data" directly on top of
          the caller's "0 / Total", printing two strings over each other. */}
      {center && hasData && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          {center}
        </div>
      )}
      {!hasData && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-ink-muted">
          No data
        </div>
      )}
    </div>
  );
}

/**
 * Legend list for categorical charts (colour swatch + name + value).
 *
 * `showShare` adds each row's proportion. For a composition chart this makes the legend do the
 * donut's job better than the donut does — the numbers are exact, aligned, and need no hover — which
 * is why the verification panel pairs the two.
 */
export function ChartLegend({
  items,
  showShare = false,
}: {
  items: { name: string; value: number; color?: string }[];
  showShare?: boolean;
}) {
  const total = items.reduce((sum, it) => sum + it.value, 0);

  return (
    // Width-capped: the legend is usually dropped into a `1fr` grid cell, and left to stretch it
    // pushed the counts hundreds of pixels away from the labels they belong to — the eye had to
    // track across empty card to pair a name with its number.
    <ul className="max-w-xs space-y-1.5 text-xs">
      {items.map((it, i) => (
        <li key={i} className="flex items-center gap-2">
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ background: it.color ?? CHART_PALETTE[i % CHART_PALETTE.length] }}
          />
          <span className="text-ink-muted">{it.name}</span>
          <span className="ml-auto font-medium tabular-nums text-ink-strong">
            {formatValue(it.value, 'count')}
          </span>
          {showShare && (
            <span className="w-9 shrink-0 text-right tabular-nums text-ink-caps">
              {formatShare(it.value, total)}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
