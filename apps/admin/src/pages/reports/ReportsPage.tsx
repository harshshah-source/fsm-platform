import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  apiFleetUptime,
  apiFleetUptimeTrend,
  apiSoftInactiveTrend,
  apiVerificationOutcomes,
  apiWorkTypeMix,
  fleetUptimeOrGap,
  type FleetUptimeReport,
  type FleetUptimeTrendPoint,
  type SoftInactiveTrend,
  type VerificationOutcomesReport,
  type VerifyOutcomeKey,
  type WorkTypeKey,
  type WorkTypeMixReport,
} from '../../api/reports';
import { apiZoneOverview, type ZoneOverviewRow } from '../../api/dashboard';
import {
  DataTable,
  EmptyState,
  MetricStrip,
  PageHeader,
  type Column,
  type Metric,
} from '../../components/data';
import { BarChartCard, BarList, CHART, ChartCard, ReportGrid, TrendChart, type BarDatum, type BarListItem, type TrendDatum } from '../../components/charts';
import { Button } from '../../components/ui';
import { ReportMetaStrip } from './DataAsOfStamp';
import { SLA_BUCKETS, BUCKET_LABEL, BUCKET_COLOR, type SlaBucket } from '../../lib/slaBucket';

/** Buckets counted as "Critical+" — CRITICAL severity and worse (CONTEXT SLA Bucket table). */
const CRITICAL_PLUS: SlaBucket[] = ['LONG_PENDING', 'VERY_SEVERE', 'SEVERE', 'HIGH_CRITICAL', 'CRITICAL'];

const WORK_TYPE_LABEL: Record<WorkTypeKey, string> = {
  TROUBLESHOOT: 'Troubleshoot',
  INSTALL: 'Install',
  RECOVERY: 'Recovery',
};

const OUTCOME_LABEL: Record<VerifyOutcomeKey, string> = {
  CLOSED: 'Verified / Passed',
  CLOSED_AUTO_RECOVERY: 'Auto-recovered',
  PARTIAL_RECOVERY: 'Partial recovery',
  FAILED_VERIFICATION: 'Failed verification',
  FAILED_ACTIVATION: 'Failed activation',
  PENDING: 'Pending',
};

/**
 * Reports landing (FE-21, ref 21). The operational reporting surface: a 6-up KPI MetricStrip, the
 * Inactivity-by-SLA-bucket bars, the Fleet Uptime % monthly trend (Issue 39) and Soft-Inactive count
 * trend (Issue 40), per-zone Fleet Uptime bars, and the Zone-breakdown table — all from real endpoints.
 *
 * Data sources: `/reports/fleet-uptime` (39, manager-scoped), `/reports/soft-inactive-trend` (40,
 * Operations-Head only — other roles see a gated panel rather than an error), and `/dashboard/zone-overview`
 * for the per-bucket / inactive counts. The Work-type-mix and Verification-outcomes panels in ref 21 have
 * no aggregation endpoint in FE-21's scope (39/40); they render as gated placeholders → BE follow-up #90,
 * rather than fabricating data, consistent with the documented-omission pattern (FE-06/07).
 */
export function ReportsPage() {
  const [fleet, setFleet] = useState<FleetUptimeReport | null>(null);
  const [uptimeTrend, setUptimeTrend] = useState<FleetUptimeTrendPoint[] | null>(null);
  const [zones, setZones] = useState<ZoneOverviewRow[] | null>(null);
  const [softInactive, setSoftInactive] = useState<SoftInactiveTrend | null>(null);
  const [softInactiveGated, setSoftInactiveGated] = useState(false);
  const [workMix, setWorkMix] = useState<WorkTypeMixReport | null>(null);
  const [outcomes, setOutcomes] = useState<VerificationOutcomesReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    // #347 — no client-clock stamp is taken here any more. The page's "Data as of" comes from the
    // report's own `dataAsOf`; a timestamp minted when the fetch resolved described the fetch, not
    // the data, and could never go stale however dead the cube cron was.
    apiFleetUptime({ groupBy: 'zone' })
      .then(setFleet)
      .catch(() => setError('Failed to load the Fleet Uptime report'));
    apiFleetUptimeTrend(6)
      .then(setUptimeTrend)
      .catch(() => setUptimeTrend([]));
    apiZoneOverview()
      .then(setZones)
      .catch(() => setZones([]));
    apiSoftInactiveTrend({ days: 14 })
      .then(setSoftInactive)
      .catch(() => setSoftInactiveGated(true));
    apiWorkTypeMix()
      .then(setWorkMix)
      .catch(() => {});
    apiVerificationOutcomes()
      .then(setOutcomes)
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const loading = fleet === null && zones === null && error === null;

  const totalInactive = useMemo(() => (zones ?? []).reduce((s, z) => s + z.inactiveOperational, 0), [zones]);

  const criticalPlus = useMemo(
    () =>
      (zones ?? []).reduce(
        (s, z) => s + CRITICAL_PLUS.reduce((b, k) => b + (z.byBucket[k] ?? 0), 0),
        0,
      ),
    [zones],
  );

  /**
   * #346 — the KPI's ONE source of truth about whether this month has an uptime at all. A month with
   * no eligible device-time is `null` here and renders as an em dash with a hint that says so: the
   * page defaults to the CURRENT month, which is exactly the month the cube cron used to skip, so
   * "no data" is a normal state of this card and not an error.
   */
  const fleetUptimeValue = fleetUptimeOrGap(fleet);
  const fleetUptimeMissing = fleet !== null && fleetUptimeValue === null;

  const metrics: Metric[] = [
    {
      label: 'Fleet Uptime',
      value: fleetUptimeValue === null ? '—' : `${fleetUptimeValue}%`,
      hint: fleetUptimeMissing ? 'No data for this month' : 'Eligible-device weighted',
      tone: fleetUptimeMissing ? 'neutral' : 'success',
      testId: 'kpi-fleet-uptime',
    },
    { label: 'Total Inactive', value: totalInactive, hint: 'Across scoped zones', tone: 'warning' },
    { label: 'Critical+', value: criticalPlus, hint: 'High-severity buckets', tone: 'critical' },
    { label: 'Eligible Devices', value: fleet?.fleet.eligibleDeviceCount ?? '—', hint: 'Active-PGI fleet', tone: 'info' },
    { label: 'Auto-Recovered', value: fleet?.fleet.autoRecoveryClosures ?? '—', hint: 'Self-healed closures', tone: 'verified' },
    { label: 'SE-Repaired', value: fleet?.fleet.seRepairedClosures ?? '—', hint: 'Field closures', tone: 'brand' },
  ];

  const bucketBars: BarDatum[] = useMemo(() => {
    if (!zones) return [];
    return SLA_BUCKETS.map((k) => ({
      name: BUCKET_LABEL[k],
      value: zones.reduce((s, z) => s + (z.byBucket[k] ?? 0), 0),
      color: BUCKET_COLOR[k],
    })).filter((b) => b.value > 0);
  }, [zones]);

  // #346 — a zone with no eligible device-time is absent from the bars rather than drawn as a
  // zero-height (or full-height) bar. A bar chart has no way to say "unknown"; omission does.
  const fleetByZone: BarDatum[] = useMemo(
    () =>
      (fleet?.rows ?? []).flatMap((r) =>
        r.uptimePct === null || r.eligibleDeviceCount <= 0 ? [] : [{ name: r.name, value: r.uptimePct }],
      ),
    [fleet],
  );

  // Work-type mix keeps all three types (the taxonomy is the story); outcome buckets drop the
  // zero-count rows (six mostly-empty bars read as noise), matching the reference panel.
  const workMixBars: BarListItem[] = useMemo(
    () => (workMix?.rows ?? []).map((r) => ({ label: WORK_TYPE_LABEL[r.workType], value: r.count })),
    [workMix],
  );
  const outcomeBars: BarListItem[] = useMemo(
    () =>
      (outcomes?.rows ?? [])
        .filter((r) => r.count > 0)
        .map((r) => ({ label: OUTCOME_LABEL[r.outcome], value: r.count })),
    [outcomes],
  );

  const softInactiveSeries: TrendDatum[] = useMemo(() => {
    if (!softInactive) return [];
    const byCapture = new Map<string, number>();
    for (const zone of softInactive.zones) {
      for (const p of zone.points) {
        byCapture.set(p.capturedAt, (byCapture.get(p.capturedAt) ?? 0) + p.softInactiveCount);
      }
    }
    return [...byCapture.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([capturedAt, value]) => ({ label: capturedAt.slice(5, 10), value }));
  }, [softInactive]);

  interface ZoneBreakdownRow {
    zoneId: string;
    zoneName: string;
    inactive: number;
    criticalPlus: number;
    uptimePct: number | null;
  }

  const breakdown: ZoneBreakdownRow[] = useMemo(() => {
    // #346 — a row with no eligible device-time carries no percentage, so it never enters the maps.
    // A missing entry and a `null` entry then mean the same thing to the lookup below, which is what
    // lets the `??` chain stay a plain fallback instead of having to distinguish the two.
    const known = (fleet?.rows ?? []).filter((r) => r.uptimePct !== null && r.eligibleDeviceCount > 0);
    const uptimeByName = new Map(known.map((r) => [r.name, r.uptimePct] as const));
    const uptimeById = new Map(known.map((r) => [r.id, r.uptimePct] as const));
    return (zones ?? []).map((z) => ({
      zoneId: z.zoneId,
      zoneName: z.zoneName,
      inactive: z.inactiveOperational,
      criticalPlus: CRITICAL_PLUS.reduce((b, k) => b + (z.byBucket[k] ?? 0), 0),
      uptimePct: uptimeById.get(z.zoneId) ?? uptimeByName.get(z.zoneName) ?? null,
    }));
  }, [zones, fleet]);

  /** Client-side CSV of the zone-breakdown table — what's on screen is what exports. */
  const exportCsv = () => {
    const header = 'Zone,Inactive w/ work,Critical+,Fleet Uptime %';
    const lines = breakdown.map((r) => [r.zoneName, r.inactive, r.criticalPlus, r.uptimePct ?? ''].join(','));
    const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `reports-zone-breakdown-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const columns: Column<ZoneBreakdownRow>[] = [
    { key: 'zone', header: 'Zone', render: (r) => r.zoneName },
    { key: 'inactive', header: 'Inactive w/ work', align: 'right', render: (r) => r.inactive },
    { key: 'critical', header: 'Critical+', align: 'right', render: (r) => r.criticalPlus },
    {
      key: 'uptime',
      header: 'Fleet Uptime',
      align: 'right',
      render: (r) =>
        r.uptimePct === null ? '—' : <span className="font-medium text-ink-strong">{r.uptimePct}%</span>,
    },
  ];

  return (
    <section>
      <PageHeader
        title="Reports"
        subtitle="Operational reporting — SLA performance, ticket throughput, fleet uptime and recovery rates. Long-range views read summary tables, never raw multi-year scans. Zone-scoped for ZM, cross-zone for CSM / Operations Head."
        actions={
          <Button
            variant="secondary"
            disabled={breakdown.length === 0}
            title="Download the zone breakdown as CSV"
            onClick={exportCsv}
          >
            Export
          </Button>
        }
      />

      {/*
        Scope meta strip (reference header band, ref 21): scoped zones then the data-as-of stamp.

        #347 — the stamp is the FLEET UPTIME CUBE's `computed_at`, which is this page's hero KPI and
        its only cube-backed source. The other two panels (work-type mix, verification outcomes) are
        live aggregations whose data time is the request instant, so they are never the constraint on
        how fresh this page is; the cube is.
      */}
      <ReportMetaStrip
        testId="reports-meta"
        dataAsOf={fleet?.dataAsOf}
        loading={fleet === null && error === null}
        stampTestId="reports-data-as-of"
      >
        <span className="font-semibold uppercase tracking-wider text-ink-caps">Scope</span>
        {(zones ?? []).map((z) => (
          <span
            key={z.zoneId}
            className="rounded-full border border-info/30 bg-info-bg px-2 py-0.5 font-medium uppercase tracking-wide text-info"
          >
            {z.zoneName}
          </span>
        ))}
        {zones !== null && zones.length === 0 && <span className="text-ink-muted">No zones in scope</span>}
      </ReportMetaStrip>

      {error && (
        <div
          role="alert"
          className="mb-4 rounded-md border border-critical/30 bg-critical-bg px-3 py-2 text-sm text-critical"
        >
          {error}
        </div>
      )}

      {loading && <p className="mb-4 text-sm text-ink-muted">Loading reports…</p>}

      <MetricStrip cols={6} metrics={metrics} />

      <ReportGrid>
        <ChartCard title="Inactivity by SLA bucket">
          {bucketBars.length ? (
            <BarChartCard data={bucketBars} />
          ) : (
            <EmptyState message="No inactive devices in the scoped zones." />
          )}
        </ChartCard>
        <ChartCard title="Fleet Uptime % — last 6 months">
          {uptimeTrend && uptimeTrend.some((p) => p.value !== null) ? (
            // Uptime clusters in the high 90s, so a zero baseline would draw six months of real
            // movement as a flat line pinned to the top of the plot.
            //
            // #346 — months with no cube row are passed through as `null`, so the line BREAKS over
            // them and the month keeps its label on the axis. Filtering them out instead would draw
            // an unbroken line through a hole, which is the same lie as plotting a number.
            <TrendChart
              data={uptimeTrend}
              format="percent"
              seriesName="Fleet uptime"
              zeroBaseline={false}
            />
          ) : (
            <EmptyState message="No monthly uptime history yet." />
          )}
        </ChartCard>
      </ReportGrid>

      <ReportGrid>
        <ChartCard title="Soft-Inactive count trend">
          {softInactiveGated ? (
            <EmptyState message="Available to Operations Head." />
          ) : softInactiveSeries.length ? (
            <TrendChart data={softInactiveSeries} seriesName="Soft-inactive devices" />
          ) : (
            <EmptyState message="No soft-inactive history yet." />
          )}
        </ChartCard>
        <ChartCard title="Fleet Uptime % by zone">
          {fleetByZone.length ? (
            // Ascending puts the WORST-performing zone at the top, which is the row that needs
            // acting on. The SLA-bucket panel above deliberately stays unsorted — its order is the
            // severity ramp.
            <BarChartCard data={fleetByZone} format="percent" sort="asc" />
          ) : (
            <EmptyState message="No per-zone uptime yet." />
          )}
        </ChartCard>
      </ReportGrid>

      <ReportGrid>
        <ChartCard title="Work type mix">
          {workMix && workMix.total > 0 ? (
            <div data-testid="work-type-mix">
              <BarList items={workMixBars} color={CHART.info} />
              <p className="mt-3 text-xs text-ink-muted">
                {workMix.total} tickets · {workMix.from} → {workMix.to}
              </p>
            </div>
          ) : (
            <EmptyState message="No tickets created in the window." />
          )}
        </ChartCard>
        <ChartCard title="Verification outcomes">
          {outcomes && outcomes.total > 0 ? (
            <div data-testid="verification-outcomes">
              <BarList items={outcomeBars} color={CHART.success} />
              <p className="mt-3 text-xs text-ink-muted">
                {outcomes.total} runs · {outcomes.fraudFlagged} fraud-flagged · {outcomes.from} → {outcomes.to}
              </p>
            </div>
          ) : (
            <EmptyState message="No verification runs in the window." />
          )}
        </ChartCard>
      </ReportGrid>

      <ChartCard title="Zone breakdown" className="mb-5">
        <DataTable
          columns={columns}
          rows={breakdown}
          rowKey={(r) => r.zoneId}
          rowTestId={(r) => `report-zone-${r.zoneId}`}
          ariaLabel="Zone breakdown"
          empty={<EmptyState message="No zone data for the current scope." />}
        />
      </ChartCard>
    </section>
  );
}
