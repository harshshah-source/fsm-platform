import { useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  BUCKET_HEX,
  BUCKET_LABEL,
  BUCKET_LABEL_RANGE,
  SLA_BUCKETS,
  type SlaBucket,
} from '../../lib/slaBucket';
import { CHART } from './colors';

/** One zone's per-bucket device counts (shape of `ZoneOverviewRow` the dashboards already hold). */
export interface SlaZoneDistribution {
  zoneName: string;
  byBucket: Record<string, number>;
}

const nf = new Intl.NumberFormat('en-IN');

/**
 * Dark value pill (uiDashboardRef "82.6 CCI" chip): bucket title, one row per zone, and the bucket
 * total. Bucket identity keeps its semantic SLA colour dot; text stays white/muted ink.
 */
function PillTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number; payload?: Record<string, unknown> }>;
}) {
  if (!active || !payload?.length) return null;
  const bucket = payload[0].payload?.bucket as SlaBucket | undefined;
  if (!bucket) return null;
  const total = payload.reduce((s, p) => s + (typeof p.value === 'number' ? p.value : 0), 0);
  return (
    <div className="rounded-lg bg-chrome-900 px-3 py-2 text-xs text-white shadow-floating ring-1 ring-white/10">
      <div className="mb-1 flex items-center gap-1.5 font-semibold">
        <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: BUCKET_HEX[bucket] }} />
        {BUCKET_LABEL_RANGE[bucket]}
      </div>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center justify-between gap-4">
          <span className="text-white/60">{p.name}</span>
          <span className="font-semibold tabular-nums">{nf.format(p.value ?? 0)}</span>
        </div>
      ))}
      <div className="mt-1 flex items-center justify-between gap-4 border-t border-white/15 pt-1">
        <span className="text-white/60">Total</span>
        <span className="font-bold tabular-nums">{nf.format(total)}</span>
      </div>
    </div>
  );
}

/**
 * SLA Bucket Distribution as the reference bar graph (docs/ui/desktop/uiDashboardSLA Bucket
 * Distribution.jpg): thin rounded per-zone bars grouped by SLA bucket over recessive gridlines, a
 * dashed fleet-average line, and a dark hover pill. Bar colours are the pinned semantic SLA heat
 * ramp (`BUCKET_HEX`) — never restyled. The legend chips below carry the same label(range) + total
 * per bucket the previous `DistributionBar` legend showed, so the counts stay readable without hover.
 */
export function SlaBucketBarChart({
  zones,
  height = 260,
}: {
  zones: SlaZoneDistribution[];
  height?: number;
}) {
  const zoneNames = useMemo(() => Array.from(new Set(zones.map((z) => z.zoneName))), [zones]);

  const rows = useMemo(
    () =>
      SLA_BUCKETS.map((b) => {
        const r: Record<string, number | string> = { bucket: b };
        for (const z of zones) r[z.zoneName] = z.byBucket[b] ?? 0;
        return r;
      }),
    [zones],
  );

  const totals = useMemo(
    () =>
      SLA_BUCKETS.map((b) => ({
        bucket: b,
        total: zones.reduce((s, z) => s + (z.byBucket[b] ?? 0), 0),
      })),
    [zones],
  );

  // Dashed reference line at the mean of the non-zero zone×bucket counts (the reference's threshold
  // line, computed rather than decorative).
  const avg = useMemo(() => {
    const values = zones.flatMap((z) => SLA_BUCKETS.map((b) => z.byBucket[b] ?? 0)).filter((v) => v > 0);
    return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
  }, [zones]);

  return (
    <div>
      <div style={{ height }} role="img" aria-label="SLA bucket distribution — device counts per bucket by zone">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 18, right: 12, bottom: 0, left: 0 }} barGap={2} barCategoryGap="26%">
            <CartesianGrid stroke={CHART.grid} vertical={false} />
            <XAxis
              dataKey="bucket"
              tickFormatter={(b: string) => BUCKET_LABEL[b as SlaBucket]}
              tick={{ fontSize: 11, fill: CHART.axis }}
              axisLine={false}
              tickLine={false}
              interval={0}
            />
            <YAxis
              tick={{ fontSize: 11, fill: CHART.axis }}
              axisLine={false}
              tickLine={false}
              width={48}
              tickFormatter={(v: number) => nf.format(v)}
            />
            <Tooltip cursor={{ fill: 'rgba(16,17,20,0.04)' }} content={<PillTooltip />} />
            {avg > 0 && (
              <ReferenceLine
                y={avg}
                stroke={CHART.axis}
                strokeDasharray="5 4"
                label={{ value: `avg ${nf.format(Math.round(avg))}`, position: 'insideTopRight', fontSize: 10, fill: CHART.axis }}
              />
            )}
            {zoneNames.map((name) => (
              <Bar key={name} dataKey={name} radius={[4, 4, 0, 0]} maxBarSize={10}>
                {SLA_BUCKETS.map((b) => (
                  <Cell key={b} fill={BUCKET_HEX[b]} />
                ))}
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Bucket legend — identical information to the previous DistributionBar legend (semantic dot,
          label + range, fleet total), so the counts never depend on hovering the chart. */}
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {totals.map(({ bucket, total }) => (
          <li key={bucket} className="flex items-center gap-1.5">
            <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: BUCKET_HEX[bucket] }} />
            <span className="text-ink-muted">{BUCKET_LABEL_RANGE[bucket]}</span>
            <span className="font-medium text-ink-strong tabular-nums">{nf.format(total)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
