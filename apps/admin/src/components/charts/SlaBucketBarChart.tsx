import { useMemo, useState } from 'react';
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
  BUCKET_COLOR,
  BUCKET_LABEL,
  BUCKET_LABEL_RANGE,
  SLA_BUCKETS,
  type SlaBucket,
} from '../../lib/slaBucket';
import { IconClose } from '../ui/icons';
import { CHART } from './colors';

/** One zone's per-bucket device counts (shape of `ZoneOverviewRow` the dashboards already hold). */
export interface SlaZoneDistribution {
  zoneName: string;
  byBucket: Record<string, number>;
}

/** A clicked bar — the zone + bucket it belongs to (drives the isolate/callout state). */
interface BarSelection {
  zone: string;
  bucket: SlaBucket;
  value: number;
}

const nf = new Intl.NumberFormat('en-IN');

/**
 * Dark value pill (uiDashboardRef "82.6 CCI" chip): bucket title, one row per zone, and the bucket
 * total. Bucket identity keeps its semantic SLA colour dot; text stays white/muted ink. When a zone
 * is click-selected, its row is emphasised.
 */
function PillTooltip({
  active,
  payload,
  selectedZone,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number; payload?: Record<string, unknown> }>;
  selectedZone?: string | null;
}) {
  if (!active || !payload?.length) return null;
  const bucket = payload[0].payload?.bucket as SlaBucket | undefined;
  if (!bucket) return null;
  const total = payload.reduce((s, p) => s + (typeof p.value === 'number' ? p.value : 0), 0);
  return (
    <div className="rounded-lg bg-chrome-900 px-3 py-2 text-xs text-white shadow-floating ring-1 ring-white/10">
      <div className="mb-1 flex items-center gap-1.5 font-semibold">
        <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: BUCKET_COLOR[bucket] }} />
        {BUCKET_LABEL_RANGE[bucket]}
      </div>
      {payload.map((p) => {
        const isSelected = selectedZone != null && p.name === selectedZone;
        return (
          <div key={p.name} className="flex items-center justify-between gap-4">
            <span className={isSelected ? 'font-semibold text-white' : 'text-white/60'}>{p.name}</span>
            <span className={`tabular-nums ${isSelected ? 'font-bold' : 'font-semibold'}`}>
              {nf.format(p.value ?? 0)}
            </span>
          </div>
        );
      })}
      <div className="mt-1 flex items-center justify-between gap-4 border-t border-white/15 pt-1">
        <span className="text-white/60">Total</span>
        <span className="font-bold tabular-nums">{nf.format(total)}</span>
      </div>
      <div className="mt-1 text-[10px] text-white/40">Click a bar to isolate its zone</div>
    </div>
  );
}

/**
 * SLA Bucket Distribution as the reference bar graph (docs/ui/desktop/uiDashboardSLA Bucket
 * Distribution.jpg): thin rounded per-zone bars grouped by SLA bucket on a soft raised plot panel,
 * a dashed fleet-average line, and a dark hover pill. Clicking a bar isolates that zone — other
 * zones' bars dim, and a callout chip names the zone, bucket, count and zone total (click the bar
 * again or the × to clear). Bar colours are the pinned semantic SLA heat ramp (`BUCKET_COLOR`) —
 * never restyled. The legend pills below carry the same label(range) + total per bucket the
 * previous `DistributionBar` legend showed, so the counts stay readable without hover.
 */
export function SlaBucketBarChart({
  zones,
  height = 260,
}: {
  zones: SlaZoneDistribution[];
  height?: number;
}) {
  const zoneNames = useMemo(() => Array.from(new Set(zones.map((z) => z.zoneName))), [zones]);
  const [clicked, setClicked] = useState<BarSelection | null>(null);
  // A refetch can rename/remove zones — a selection pointing at a vanished zone silently clears.
  const selected = clicked && zoneNames.includes(clicked.zone) ? clicked : null;

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

  const selectedZoneTotal = useMemo(() => {
    if (!selected) return 0;
    const zone = zones.find((z) => z.zoneName === selected.zone);
    return zone ? SLA_BUCKETS.reduce((s, b) => s + (zone.byBucket[b] ?? 0), 0) : 0;
  }, [zones, selected]);

  const toggleBar = (zone: string, payload: Record<string, unknown> | undefined): void => {
    const bucket = payload?.bucket as SlaBucket | undefined;
    if (!bucket) return;
    const value = typeof payload?.[zone] === 'number' ? (payload[zone] as number) : 0;
    setClicked((cur) => (cur && cur.zone === zone && cur.bucket === bucket ? null : { zone, bucket, value }));
  };

  return (
    <div>
      <p className="mb-3 text-xs text-ink-muted">
        Device counts per SLA bucket, split by zone — hover a bucket for per-zone counts,{' '}
        <span className="font-medium text-ink">click a bar to see which zone it is</span>.
      </p>

      {/* Soft raised plot panel (reference chart sits on a subtle gray field inside the white card). */}
      <div className="rounded-xl bg-surface-raised/70 p-3 ring-1 ring-line/70">
        <div
          style={{ height }}
          role="img"
          aria-label="SLA bucket distribution — device counts per bucket by zone"
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} margin={{ top: 18, right: 12, bottom: 0, left: 0 }} barGap={2} barCategoryGap="26%">
              <CartesianGrid stroke={CHART.grid} vertical={false} />
              <XAxis
                dataKey="bucket"
                tickFormatter={(b: string) => BUCKET_LABEL[b as SlaBucket]}
                tick={{ fontSize: 11, fill: 'var(--color-ink-muted)', fontWeight: 500 }}
                axisLine={false}
                tickLine={false}
                interval={0}
              />
              <YAxis
                tick={{ fontSize: 10, fill: CHART.axis }}
                axisLine={false}
                tickLine={false}
                width={48}
                tickFormatter={(v: number) => nf.format(v)}
              />
              <Tooltip
                cursor={{ fill: 'var(--color-surface-sunken)', fillOpacity: 0.55 }}
                content={<PillTooltip selectedZone={selected?.zone ?? null} />}
              />
              {avg > 0 && (
                <ReferenceLine
                  y={avg}
                  stroke={CHART.axis}
                  strokeDasharray="5 4"
                  label={{ value: `avg ${nf.format(Math.round(avg))}`, position: 'insideTopRight', fontSize: 10, fill: CHART.axis }}
                />
              )}
              {zoneNames.map((name) => (
                <Bar
                  key={name}
                  dataKey={name}
                  radius={[4, 4, 0, 0]}
                  maxBarSize={10}
                  cursor="pointer"
                  onClick={(entry: { payload?: Record<string, unknown> }) => toggleBar(name, entry?.payload)}
                >
                  {SLA_BUCKETS.map((b) => {
                    const isClickedBar = selected?.zone === name && selected.bucket === b;
                    return (
                      <Cell
                        key={b}
                        fill={BUCKET_COLOR[b]}
                        fillOpacity={selected && selected.zone !== name ? 0.22 : 1}
                        // Selection outline: the page ink, so it stays visible when the canvas inverts.
                        stroke={isClickedBar ? 'var(--color-ink-strong)' : undefined}
                        strokeWidth={isClickedBar ? 1.5 : 0}
                      />
                    );
                  })}
                </Bar>
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Click callout — names the zone behind the clicked bar; the rest of the chart dims to match. */}
      {selected && (
        <div
          role="status"
          data-testid="sla-zone-callout"
          className="mt-3 inline-flex max-w-full flex-wrap items-center gap-x-2.5 gap-y-1 rounded-lg border border-line bg-chrome-900 px-3 py-2 text-xs text-white shadow-card"
        >
          <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: BUCKET_COLOR[selected.bucket] }} />
          <span className="font-bold">{selected.zone} zone</span>
          <span className="text-white/60">{BUCKET_LABEL_RANGE[selected.bucket]}</span>
          <span className="font-bold tabular-nums">{nf.format(selected.value)} devices</span>
          <span className="text-white/60">· {nf.format(selectedZoneTotal)} across all buckets</span>
          <button
            type="button"
            aria-label="Clear zone selection"
            onClick={() => setClicked(null)}
            className="ml-1 flex h-5 w-5 items-center justify-center rounded-md text-white/70 transition-colors hover:bg-white/15 hover:text-white focus-ring"
          >
            <IconClose className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Bucket legend — identical information to the previous DistributionBar legend (semantic dot,
          label + range, fleet total), styled as quiet pills on the app surface tokens. */}
      <ul className="mt-3 flex flex-wrap gap-1.5 text-xs">
        {totals.map(({ bucket, total }) => (
          <li
            key={bucket}
            className="flex items-center gap-1.5 rounded-full border border-line bg-surface-card px-2.5 py-1 shadow-sm"
          >
            <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: BUCKET_COLOR[bucket] }} />
            <span className="text-ink-muted">{BUCKET_LABEL_RANGE[bucket]}</span>
            <span className="font-semibold tabular-nums text-ink-strong">{nf.format(total)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
