import { useId } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ActivityTrendBucket, ActivityTrendPoint } from '../../api/dashboard';
import { ChartTooltip, type TooltipPayloadEntry } from './ChartTooltip';
import { CHART } from './colors';
import { formatTick, niceStep } from './format';

/** Human label for a bucket start, keyed to the granularity (hour → `14:00`, day → `07-19`,
 *  month → `2026-07`). Input is the Postgres `YYYY-MM-DD HH:MM:SS` bucket string. */
function bucketLabel(bucket: string, unit: ActivityTrendBucket): string {
  if (unit === 'hour') return bucket.slice(11, 16);
  if (unit === 'month') return bucket.slice(0, 7);
  return bucket.slice(5, 10);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Un-abbreviated bucket, for the tooltip heading. The axis has to fit a dozen ticks so it shows
 * `08-15`; the tooltip has the room for `15 Aug 2026` and needs it — `08-15` alone is ambiguous
 * across years on a 1Y/MAX range, which is exactly where the trend matters most.
 */
function fullBucketLabel(bucket: string, unit: ActivityTrendBucket): string {
  const year = bucket.slice(0, 4);
  const month = MONTHS[Number(bucket.slice(5, 7)) - 1] ?? bucket.slice(5, 7);
  const day = bucket.slice(8, 10);
  if (unit === 'month') return `${month} ${year}`;
  if (unit === 'hour') return `${day} ${month}, ${bucket.slice(11, 16)}`;
  return `${day} ${month} ${year}`;
}

/** Number of ticks on the ticket axis, including both endpoints. */
const TICKET_TICKS = 5;

/**
 * Headroom multiplier on the ticket axis. Holds the two ticket traces in the lower band of the plot
 * and leaves the upper band to the stock trace, so the three lines read as separate signals rather
 * than tangling through one another.
 */
const TICKET_HEADROOM = 1.7;

/** The three traces, in the order they read in the tooltip and the legend. */
const SERIES = [
  { key: 'inactive', name: 'Inactive Devices', color: CHART.warning, axis: 'stock' },
  { key: 'troubleshoot', name: 'Troubleshoot', color: CHART.brand, axis: 'tickets' },
  { key: 'installation', name: 'Installation', color: CHART.info, axis: 'tickets' },
] as const;

/**
 * Fleet-activity trend (Issue 134) — Inactive-device stock against Troubleshoot and Installation
 * ticket creation, drawn as three signal traces over one time axis.
 *
 * ## The pulse treatment
 *
 * `type="linear"` rather than `monotone` is what makes this read as a signal: a monotone spline
 * invents smooth curvature between samples that the data never had, rounding off the very spikes an
 * operator is scanning for. Straight segments join sample to sample and leave a spike looking like a
 * spike. Strokes are thin and crisp with round joins, over a dimmed grid, and each trace carries a
 * restrained glow so it reads as an emitted signal rather than an inked line.
 *
 * The glow is deliberately reintroduced here (an earlier pass stripped a `drop-shadow` from this
 * chart as decoration). It was genuinely harmful *then*: all three traces shared one axis, sat on
 * top of one another, and the blur merged near-equal series into a single smear. With the two scales
 * banded apart — below — the traces no longer overlap, so the glow costs nothing in legibility. It
 * is applied via an SVG filter that merges the blur *under* the untouched source graphic, so the
 * core stroke stays sharp and only the halo is soft.
 *
 * ## Why two Y scales
 *
 * `inactive` is a device stock, routinely in the thousands; the ticket series are per-bucket counts
 * in the tens. On one shared axis both ticket traces flattened to straight lines on the baseline —
 * two thirds of the chart carrying no information. The left scale is the stock, tinted to match its
 * trace; the right is ticket flow, left neutral because two differently-coloured traces share it.
 * `TICKET_HEADROOM` then holds the ticket traces to the lower band so the three signals stay
 * visually separable.
 *
 * A caveat worth stating rather than burying: the ticket series are *flows* (events counted within a
 * bucket), and joining flow samples with a line implies a continuous rate between them that does not
 * literally exist. Bars carry a per-bucket quantity more honestly. Lines are the deliberate choice
 * here for signal legibility across five ranges — the same trade every ops-monitoring dashboard
 * makes when it line-charts a request rate.
 */
export function FleetActivityTrendChart({
  points,
  bucket,
  height = 260,
}: {
  points: ActivityTrendPoint[];
  bucket: ActivityTrendBucket;
  height?: number;
}) {
  // Filter ids are document-global; `useId` keeps two mounted charts from sharing one. The colons
  // React emits are not valid in a `url(#…)` reference, so they are stripped.
  const glowId = `pulse-glow-${useId().replace(/:/g, '')}`;

  const data = points.map((p) => ({
    label: bucketLabel(p.bucket, bucket),
    bucket: p.bucket,
    inactive: p.inactive,
    troubleshoot: p.troubleshoot,
    installation: p.installation,
  }));

  // The inactive series is snapshot-sparse (twice-daily history) and can collapse to a single point —
  // e.g. only the live count when the history table is empty. Recharts draws no line from one point and
  // draws no marker with `dot={false}`, so that lone value would be invisible. Render a dot only for an
  // *isolated* inactive point (both neighbours null); dense stretches stay clean lines with no dots.
  const inactiveDot = (props: { cx?: number; cy?: number; index?: number; value?: number | null }) => {
    const { cx, cy, index, value } = props;
    if (cx == null || cy == null || value == null || index == null) return <g key={`inact-${index}`} />;
    const isolated = data[index - 1]?.inactive == null && data[index + 1]?.inactive == null;
    return isolated ? (
      <circle key={`inact-${index}`} cx={cx} cy={cy} r={3} fill={CHART.warning} />
    ) : (
      <g key={`inact-${index}`} />
    );
  };

  // Per-axis maxima, so each side compacts its ticks as a whole rather than tick by tick.
  const stockMax = data.reduce((max, d) => Math.max(max, d.inactive ?? 0), 0);
  const ticketMax = data.reduce((max, d) => Math.max(max, d.troubleshoot, d.installation), 0);
  const ticketDomainMax =
    niceStep(Math.max(1, ticketMax * TICKET_HEADROOM) / (TICKET_TICKS - 1)) * (TICKET_TICKS - 1);

  const labelFormat = (fallback: string, entry?: TooltipPayloadEntry) => {
    const raw = entry?.payload?.bucket;
    return typeof raw === 'string' ? fullBucketLabel(raw, bucket) : fallback;
  };

  return (
    <div data-testid="activity-trend-chart">
      {/* Static legend chips — outside the SVG, so they never collide with the plot. Each carries a
          line rule in its trace colour. */}
      <ul className="mb-2 flex flex-wrap items-center justify-end gap-x-4 gap-y-1 text-[11px]">
        {SERIES.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span aria-hidden className="h-0.5 w-4 rounded-full" style={{ background: s.color }} />
            <span className="font-medium text-ink-muted">{s.name}</span>
          </li>
        ))}
      </ul>

      {/* Axis captions, colour-keyed to the scale each one governs. */}
      <div className="mb-1 flex items-baseline justify-between text-[10px] font-semibold uppercase tracking-[0.14em]">
        <span style={{ color: CHART.warning }}>Inactive devices</span>
        <span className="text-ink-caps">Tickets created</span>
      </div>

      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 10, right: 4, bottom: 0, left: 0 }}>
            <defs>
              {/* Halo under a crisp core: blur the stroke, then paint the untouched source back on
                  top of it. A plain `drop-shadow` blurs the line itself and thickens it. */}
              <filter id={glowId} x="-25%" y="-25%" width="150%" height="150%">
                <feGaussianBlur stdDeviation="3" result="halo" />
                <feComponentTransfer in="halo" result="softHalo">
                  <feFuncA type="linear" slope="0.55" />
                </feComponentTransfer>
                <feMerge>
                  <feMergeNode in="softHalo" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            {/* Dimmed grid — a signal trace should sit above its graticule, not compete with it. */}
            <CartesianGrid stroke={CHART.grid} strokeOpacity={0.6} vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: CHART.axis }}
              axisLine={false}
              tickLine={false}
              // Wide enough that a 24-bucket hourly range thins to every second hour. At 28 every
              // `00:00`…`23:00` label cleared the overlap test and rendered, packing the axis with
              // ticks nobody reads.
              minTickGap={42}
            />
            {/* Left: device stock. Tinted amber to bind it to the one trace it carries. */}
            <YAxis
              yAxisId="stock"
              tick={{ fontSize: 11, fill: CHART.warning }}
              axisLine={false}
              tickLine={false}
              width={46}
              allowDecimals={false}
              tickFormatter={(v: number) => formatTick(v, 'count', stockMax)}
            />
            {/* Right: ticket flow. Neutral, because two differently-coloured traces share it. */}
            <YAxis
              yAxisId="tickets"
              orientation="right"
              tick={{ fontSize: 11, fill: CHART.axis }}
              axisLine={false}
              tickLine={false}
              width={40}
              allowDecimals={false}
              domain={[0, ticketDomainMax]}
              tickCount={TICKET_TICKS}
              interval={0}
              tickFormatter={(v: number) => formatTick(v, 'count', ticketMax)}
            />
            <Tooltip
              cursor={{ stroke: CHART.axis, strokeWidth: 1, strokeDasharray: '3 3' }}
              content={
                <ChartTooltip
                  format="count"
                  labelFormat={labelFormat}
                  showTotal
                  // Only the two flows are additive — folding the device stock into this total
                  // would produce a number that means nothing.
                  totalKeys={['troubleshoot', 'installation']}
                  totalLabel="Tickets created"
                />
              }
            />
            {SERIES.map((s) => (
              <Line
                key={s.key}
                yAxisId={s.axis}
                name={s.name}
                // Straight segments, not a spline: a monotone curve rounds off the spikes that are
                // the whole point of watching this chart.
                type="linear"
                dataKey={s.key}
                stroke={s.color}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ filter: `url(#${glowId})` }}
                dot={s.key === 'inactive' ? inactiveDot : false}
                activeDot={{ r: 3.5, strokeWidth: 2, stroke: 'var(--color-surface-card)' }}
                connectNulls={s.key === 'inactive'}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
