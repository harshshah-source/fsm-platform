import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ActivityTrendBucket, ActivityTrendPoint } from '../../api/dashboard';
import { CHART } from './colors';

/** Human label for a bucket start, keyed to the granularity (hour → `14:00`, day → `07-19`,
 *  month → `2026-07`). Input is the Postgres `YYYY-MM-DD HH:MM:SS` bucket string. */
function bucketLabel(bucket: string, unit: ActivityTrendBucket): string {
  if (unit === 'hour') return bucket.slice(11, 16);
  if (unit === 'month') return bucket.slice(0, 7);
  return bucket.slice(5, 10);
}

/**
 * Fleet-activity trend (Issue 134) — three lines over one time axis: Inactive-device stock (amber),
 * Troubleshoot tickets created (brand red), Installation tickets created (blue). `connectNulls` on the
 * inactive line bridges buckets with no snapshot (twice-daily history is sparse). Semantic colours from
 * the shared chart kit; sized by the caller.
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
  const data = points.map((p) => ({
    label: bucketLabel(p.bucket, bucket),
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

  return (
    <div className="relative" style={{ height }} data-testid="activity-trend-chart">
      <span className="pointer-events-none absolute left-14 top-1 z-10 text-[10px] font-extrabold uppercase tracking-[0.16em] text-ink-caps">Device / ticket count</span>
      <span className="pointer-events-none absolute bottom-0 right-4 z-10 text-[10px] font-extrabold uppercase tracking-[0.16em] text-ink-caps">Date</span>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 34, right: 16, bottom: 30, left: 12 }}>
          <CartesianGrid stroke={CHART.grid} vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: CHART.axis }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 11, fill: CHART.axis }} axisLine={false} tickLine={false} width={44} allowDecimals={false} />
          <Tooltip />
          <Legend verticalAlign="top" align="right" height={24} wrapperStyle={{ fontSize: 12, fontWeight: 700, paddingTop: 2 }} />
          <Line name="Inactive Devices" type="monotone" dataKey="inactive" stroke={CHART.warning} strokeWidth={2.5} style={{ filter: `drop-shadow(0 0 2px ${CHART.warning})` }} dot={inactiveDot} connectNulls />
          <Line name="Troubleshoot" type="monotone" dataKey="troubleshoot" stroke={CHART.brand} strokeWidth={2.5} style={{ filter: `drop-shadow(0 0 2px ${CHART.brand})` }} dot={false} />
          <Line name="Installation" type="monotone" dataKey="installation" stroke={CHART.info} strokeWidth={2.5} style={{ filter: `drop-shadow(0 0 2px ${CHART.info})` }} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}





