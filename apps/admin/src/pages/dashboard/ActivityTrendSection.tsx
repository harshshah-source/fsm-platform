import { useEffect, useMemo, useState } from 'react';
import { apiActivityTrend, type ActivityTrendRange, type ActivityTrendReport } from '../../api/dashboard';
import { FleetActivityTrendChart } from '../../components/charts/FleetActivityTrendChart';
import { FilterSelect, Skeleton } from '../../components/data';
import { cn } from '../../lib/cn';

const RANGES: { key: ActivityTrendRange; label: string }[] = [
  { key: '1D', label: '1D' },
  { key: '7D', label: '7D' },
  { key: '1M', label: '1M' },
  { key: '1Y', label: '1Y' },
  { key: 'MAX', label: 'MAX' },
];

interface ZoneOption {
  zoneId: string;
  zoneName: string;
}

/**
 * Fleet-activity trend section (Issue 134) — Inactive-device stock vs Troubleshoot vs Installation
 * over a selectable range (1D / 7D / 1M / 1Y / MAX). For a cross-zone role (OH / CSM) a Pan-India /
 * Zone-wise toggle plus a zone dropdown scope the chart; a ZM always sees their own zone (the backend
 * clamps), so `canSelectZone` is false and the controls are hidden. Rendered between the KPI hero and
 * the SLA Bucket Distribution.
 */
export function ActivityTrendSection({
  zones,
  canSelectZone,
}: {
  zones: ZoneOption[];
  canSelectZone: boolean;
}) {
  const [range, setRange] = useState<ActivityTrendRange>('7D');
  const [zoneWise, setZoneWise] = useState(false);
  const [zoneId, setZoneId] = useState('');
  const [report, setReport] = useState<ActivityTrendReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // Zone-wise with no explicit pick defaults to the first zone; pan-India (or a ZM) sends no zoneId.
  const effectiveZone = useMemo(() => {
    if (!canSelectZone || !zoneWise) return undefined;
    return zoneId || zones[0]?.zoneId || undefined;
  }, [canSelectZone, zoneWise, zoneId, zones]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(false);
    apiActivityTrend({ range, zoneId: effectiveZone })
      .then((r) => alive && (setReport(r), setLoading(false)))
      .catch(() => alive && (setError(true), setLoading(false)));
    return () => {
      alive = false;
    };
  }, [range, effectiveZone]);

  // Defensive: an older/misbehaving backend may not return a well-formed report — treat it as no-data
  // rather than crashing the dashboard that hosts this section.
  const points = Array.isArray(report?.points) ? report!.points : [];
  const hasData = points.some((p) => p.inactive != null || p.troubleshoot > 0 || p.installation > 0);

  return (
    <section aria-labelledby="activity-trend-heading" className="mb-8">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3
          id="activity-trend-heading"
          className="text-[11px] font-semibold uppercase tracking-wider text-ink-caps"
        >
          Fleet Activity Trend
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          {canSelectZone && (
            <>
              {/* Pan-India / Zone-wise view toggle. */}
              <div
                role="group"
                aria-label="Trend view"
                className="flex items-center gap-1 rounded-full border border-line bg-surface-card p-1 text-[11px] shadow-sm"
              >
                {[
                  { key: false, label: 'Pan-India' },
                  { key: true, label: 'Zone-wise' },
                ].map((v) => (
                  <button
                    key={v.label}
                    type="button"
                    aria-pressed={zoneWise === v.key}
                    onClick={() => setZoneWise(v.key)}
                    className={cn(
                      'rounded-full px-2.5 py-1 font-semibold transition-colors focus-ring',
                      zoneWise === v.key
                        ? 'bg-brand-600 text-white'
                        : 'text-ink-muted hover:bg-surface-sunken hover:text-ink-strong',
                    )}
                  >
                    {v.label}
                  </button>
                ))}
              </div>
              {zoneWise && (
                <FilterSelect
                  aria-label="Select zone"
                  value={zoneId || zones[0]?.zoneId || ''}
                  onChange={(e) => setZoneId(e.target.value)}
                  className="h-8 text-xs"
                >
                  {zones.map((z) => (
                    <option key={z.zoneId} value={z.zoneId}>
                      {z.zoneName}
                    </option>
                  ))}
                </FilterSelect>
              )}
            </>
          )}
          {/* Range selector: 1D 7D 1M 1Y MAX. */}
          <div
            role="group"
            aria-label="Trend range"
            className="flex items-center gap-1 rounded-full border border-line bg-surface-card p-1 text-[11px] shadow-sm"
          >
            {RANGES.map((r) => (
              <button
                key={r.key}
                type="button"
                aria-pressed={range === r.key}
                onClick={() => setRange(r.key)}
                className={cn(
                  'rounded-full px-2.5 py-1 font-semibold transition-colors focus-ring',
                  range === r.key
                    ? 'bg-brand-600 text-white'
                    : 'text-ink-muted hover:bg-surface-sunken hover:text-ink-strong',
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="rounded-card border border-line bg-surface-card p-4 shadow-sm">
        {loading ? (
          <Skeleton className="h-64 w-full" />
        ) : error ? (
          <p role="alert" className="py-16 text-center text-sm text-critical">
            Couldn’t load the activity trend.
          </p>
        ) : !hasData ? (
          <p className="py-16 text-center text-sm text-ink-muted">
            No activity in this period yet — telemetry and ticket history are still accruing.
          </p>
        ) : (
          <FleetActivityTrendChart points={points} bucket={report?.bucket ?? 'day'} />
        )}
      </div>
    </section>
  );
}
