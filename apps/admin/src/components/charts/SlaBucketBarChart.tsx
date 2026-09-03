import { useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  BUCKET_COLOR,
  BUCKET_LABEL_RANGE,
  SLA_BUCKETS,
  criticalPlusCount,
  type SlaBucket,
} from '../../lib/slaBucket';
import { ChartTooltip } from './ChartTooltip';
import { CHART } from './colors';
import { formatTick, formatValue } from './format';

/** One zone's per-bucket device counts (shape of `ZoneOverviewRow` the dashboards already hold). */
export interface SlaZoneDistribution {
  zoneName: string;
  byBucket: Record<string, number>;
}

/** Row height per zone, and the space the X axis needs under the plot. */
const ROW_HEIGHT = 44;
const AXIS_HEIGHT = 34;

/**
 * SLA Bucket Distribution — one stacked bar per zone, segments ordered worst-SLA-first.
 *
 * ## Why this is not the grouped chart it used to be
 *
 * The previous version put SLA bucket on the X axis and drew one bar per zone inside each bucket
 * group — but coloured every bar in a group by its BUCKET, so all five zones in a group were the
 * same colour, with no zone axis and no zone legend. Zone identity had *no visual encoding at all*.
 * The panel's own subtitle conceded it ("click a bar to see which zone it is"), which made reading
 * the whole chart a forty-click exercise. That shape came from adapting
 * `uiDashboardSLA Bucket Distribution.jpg` a little too literally: in the reference the bars inside
 * a group are sequential TIME points, so one hue is right and colour carries nothing. Here the
 * grouping variable is a category that has to be identifiable, and the same treatment discards it.
 *
 * ## What the stack order is doing
 *
 * Segments run in `SLA_BUCKETS` order, which is worst-first — so LONG_PENDING starts at x=0 on every
 * row. That is the whole point: **segments sharing a baseline are comparable, segments floating
 * mid-bar are not.** Anchoring the severe end at the axis makes "which zone has the worst tail" a
 * glance instead of a click, and it is the one comparison the grouped version could not support at
 * any effort. Total bar length still reads as the zone's total inactive fleet.
 *
 * Zones are ordered by `criticalPlusCount` descending — the canonical critical+ definition from
 * `slaBucket.ts`, not a second one invented here — so the zone needing attention is the top row.
 *
 * Colours stay the pinned semantic SLA heat ramp (`BUCKET_COLOR`), never restyled: it is an ordinal
 * scale validated for monotone lightness, which is what keeps it readable under deuteranopia and on
 * the dark canvas. Colouring by zone instead would have identified zones at the cost of that.
 *
 * ## Deliberately removed
 *
 * - **The dashed "avg" line.** It averaged non-zero zone×bucket cells, mixing a ~3,000-device
 *   `4–8Hr` cell with a ~40-device `7d+` one. It rendered as `avg 892` and read like a threshold
 *   while having no operational referent at all.
 * - **Click-to-isolate and its callout chip.** Both existed only to recover the zone identity the
 *   encoding threw away. With zones on the axis there is nothing left to isolate.
 */
export function SlaBucketBarChart({
  zones,
  height,
}: {
  zones: SlaZoneDistribution[];
  height?: number;
}) {
  // Worst-first by critical+ load. Sorted on a copy — the caller's array is shared with the
  // scorecard and the KPI strip, and reordering it in place would reorder those too.
  const rows = useMemo(
    () =>
      [...zones]
        .sort((a, b) => criticalPlusCount(b.byBucket) - criticalPlusCount(a.byBucket))
        .map((z) => {
          const row: Record<string, number | string> = { zoneName: z.zoneName };
          let total = 0;
          for (const b of SLA_BUCKETS) {
            const n = z.byBucket[b] ?? 0;
            row[b] = n;
            total += n;
          }
          row.total = total;
          return row;
        }),
    [zones],
  );

  const totals = useMemo(
    () =>
      SLA_BUCKETS.map((b) => ({
        bucket: b,
        total: zones.reduce((sum, z) => sum + (z.byBucket[b] ?? 0), 0),
      })),
    [zones],
  );

  // Whole-axis compaction, and headroom for the row-total labels at the end of each bar.
  const axisMax = useMemo(
    () => rows.reduce((max, r) => Math.max(max, r.total as number), 0),
    [rows],
  );

  // Derived from the row count, so a single-zone ZM view is one properly-proportioned bar rather
  // than the eight stranded 10px slivers the fixed-height grouped version produced.
  const resolvedHeight = height ?? rows.length * ROW_HEIGHT + AXIS_HEIGHT;

  return (
    <div>
      <p className="mb-3 text-xs text-ink-muted">
        Inactive devices per zone, split by SLA bucket. Bars start with the{' '}
        <span className="font-medium text-ink">worst</span> buckets, so the severe end of every zone
        lines up and can be compared directly. Zones are ordered by critical+ load.
      </p>

      {/* Soft raised plot panel (reference chart sits on a subtle gray field inside the white card). */}
      <div className="rounded-xl bg-surface-raised/70 p-3 ring-1 ring-line/70">
        <div
          style={{ height: resolvedHeight }}
          role="img"
          aria-label="SLA bucket distribution — inactive device counts per zone, split by SLA bucket, worst buckets first"
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              layout="vertical"
              data={rows}
              // Right margin holds the row-total label.
              margin={{ top: 4, right: 56, bottom: 0, left: 0 }}
              barCategoryGap="28%"
            >
              <CartesianGrid stroke={CHART.grid} horizontal={false} />
              <XAxis
                type="number"
                tick={{ fontSize: 10, fill: CHART.axis }}
                axisLine={false}
                tickLine={false}
                allowDecimals={false}
                tickFormatter={(v: number) => formatTick(v, 'count', axisMax)}
              />
              {/* Zone on the axis — the identity the grouped version had no way to show. Short
                  zone names (NORTH / SOUTH / …) mean this survives a narrow viewport, where the
                  old bucket-on-X axis collapsed into an unreadable smear of overlapping labels. */}
              <YAxis
                type="category"
                dataKey="zoneName"
                width={78}
                tick={{ fontSize: 11, fill: 'var(--color-ink-muted)', fontWeight: 500 }}
                axisLine={false}
                tickLine={false}
                interval={0}
              />
              <Tooltip
                cursor={{ fill: 'var(--color-surface-sunken)', fillOpacity: 0.55 }}
                content={
                  <ChartTooltip format="count" showTotal showShare hideZeroRows />
                }
              />
              {SLA_BUCKETS.map((b, i) => (
                <Bar
                  key={b}
                  dataKey={b}
                  name={BUCKET_LABEL_RANGE[b as SlaBucket]}
                  stackId="sla"
                  fill={BUCKET_COLOR[b as SlaBucket]}
                  // Hairline in the card surface between segments. `DistributionBar` documents the
                  // same need for the same reason: without a break, two neighbouring steps of an
                  // ordinal ramp read as one longer segment — precisely the misreading a heat ramp
                  // invites, and worst at the red end where consecutive steps are closest.
                  stroke="var(--color-surface-card)"
                  strokeWidth={1.5}
                  isAnimationActive={false}
                >
                  {/* The row total rides on the LAST segment, so it lands just past the end of the
                      stack whatever the mix. `dataKey="total"` supplies the value; the segment only
                      supplies the position. */}
                  {i === SLA_BUCKETS.length - 1 && (
                    <LabelList
                      dataKey="total"
                      position="right"
                      offset={8}
                      formatter={(v: number) => formatValue(v, 'count')}
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        fill: 'var(--color-ink-strong)',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    />
                  )}
                </Bar>
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Bucket legend — the colour key for the stack (eight segments need one) AND the fleet-wide
          per-bucket totals, which read faster here than they ever did off the bars. */}
      <ul className="mt-3 flex flex-wrap gap-1.5 text-xs">
        {totals.map(({ bucket, total }) => (
          // Empty buckets are DIMMED, not dropped: "nothing in 7d+" is a result worth stating, and
          // the strip doubles as the colour key for an eight-segment stack, so removing entries
          // would put holes in the key. A healthy zone otherwise renders six identical `0` pills at
          // full weight, which reads as clutter rather than as good news.
          <li
            key={bucket}
            className={`flex items-center gap-1.5 rounded-full border border-line bg-surface-card px-2.5 py-1 shadow-sm${
              total === 0 ? ' opacity-45' : ''
            }`}
          >
            <span
              aria-hidden
              className="h-2 w-2 rounded-full"
              style={{ background: BUCKET_COLOR[bucket as SlaBucket] }}
            />
            <span className="text-ink-muted">{BUCKET_LABEL_RANGE[bucket as SlaBucket]}</span>
            <span className="font-semibold tabular-nums text-ink-strong">
              {formatValue(total, 'count')}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
