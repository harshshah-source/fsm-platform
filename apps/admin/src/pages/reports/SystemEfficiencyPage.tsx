import { useEffect, useMemo, useState } from 'react';
import { apiSystemEfficiency, type SystemEfficiencyReport } from '../../api/reports';
import { BarChartCard, ChartCard, ReportGrid, type BarDatum } from '../../components/charts';
import { DataTable, EmptyState, MetricStrip, PageHeader, type Column, type Metric } from '../../components/data';
import { ReportMetaStrip } from './DataAsOfStamp';

type ZoneRow = SystemEfficiencyReport['byZone'][number];

/**
 * FE-24 — System Efficiency (ref 24). A dense KPI grid (auto-dispatch %, override %, first-time-fix %,
 * auto-recovery %, failed-verification %, auto-escalations), an auto-dispatch-by-zone `BarChartCard`,
 * and a per-zone metrics `DataTable` — all from the Issue 42 `/reports/efficiency` endpoint. The
 * reference's "SE active load vs capacity" and "recent overrides & audit" panels have no aggregation
 * source in this endpoint; they render as gated placeholders rather than fabricated data (FE-21 pattern).
 */
export function SystemEfficiencyPage() {
  const [report, setReport] = useState<SystemEfficiencyReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiSystemEfficiency()
      .then(setReport)
      .catch(() => setError('Failed to load the System Efficiency report'));
  }, []);

  const loading = report === null && error === null;
  const f = report?.fleet;
  const zones = report?.byZone ?? [];

  const metrics: Metric[] = [
    { label: 'Auto-Dispatch', value: f ? `${f.autoAssignmentRatePct}%` : '—', hint: 'Auto vs manual assignment', tone: 'success' },
    { label: 'Override Rate', value: f ? `${f.overrideRatePct}%` : '—', hint: 'ZM overrides of auto-dispatch', tone: 'warning' },
    { label: 'First-Time Fix', value: f ? `${f.firstTimeFixRatePct}%` : '—', hint: 'Verified without repeat', tone: 'verified' },
    { label: 'Auto-Recovery', value: f ? `${f.autoRecoveryRatePct}%` : '—', hint: 'Self-healed closures', tone: 'info' },
    { label: 'Failed Verification', value: f ? `${f.failedVerificationRatePct}%` : '—', hint: 'Of resolved cycles', tone: 'critical' },
    { label: 'Auto-Escalations', value: f?.autoEscalations ?? '—', hint: 'Cross-zone Platinum', tone: 'brand' },
  ];

  const dispatchByZone: BarDatum[] = useMemo(
    () => zones.map((z) => ({ name: z.zoneName ?? String(z.zoneId), value: z.autoAssignmentRatePct })),
    [zones],
  );

  const columns: Column<ZoneRow>[] = [
    { key: 'zone', header: 'Zone', render: (r) => r.zoneName ?? String(r.zoneId) },
    { key: 'tickets', header: 'Tickets', align: 'right', render: (r) => r.ticketsCreated },
    { key: 'auto', header: 'Auto-dispatch', align: 'right', render: (r) => `${r.autoAssignmentRatePct}%` },
    { key: 'override', header: 'Override', align: 'right', render: (r) => `${r.overrideRatePct}%` },
    { key: 'ftf', header: 'First-time fix', align: 'right', render: (r) => `${r.firstTimeFixRatePct}%` },
  ];

  return (
    <section>
      <PageHeader
        title="System Efficiency"
        subtitle="End-to-end pipeline metrics — detection, assignment, resolution, verification and escalation — from the daily efficiency cube. Zone-scoped for ZM, cross-zone for CSM / Operations Head."
      />

      {/* #347 — ref 24's header band. This page is served entirely from a DAILY cube, so a stopped
          `business-system-efficiency` sweep is exactly what the stamp has to be able to show. */}
      <ReportMetaStrip dataAsOf={report?.dataAsOf} loading={loading} stampTestId="efficiency-data-as-of" />

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-critical/30 bg-critical-bg px-3 py-2 text-sm text-critical">
          {error}
        </div>
      )}
      {loading && <p className="mb-4 text-sm text-ink-muted">Loading efficiency report…</p>}

      <MetricStrip cols={6} metrics={metrics} />

      <ReportGrid>
        <ChartCard title="Auto-dispatch % by zone">
          {/* Ascending — the zone automating least is the one to act on. */}
          {dispatchByZone.length ? <BarChartCard data={dispatchByZone} format="percent" sort="asc" /> : <EmptyState message="No per-zone data in this window." />}
        </ChartCard>
        <ChartCard title="SE active load vs capacity">
          <EmptyState message="Per-SE load vs capacity — no aggregation source in this endpoint (future backend follow-up)." />
        </ChartCard>
      </ReportGrid>

      <ChartCard title="Efficiency by zone" className="mb-5">
        <DataTable
          columns={columns}
          rows={zones}
          rowKey={(r) => String(r.zoneId)}
          rowTestId={(r) => `eff-row-${r.zoneId}`}
          ariaLabel="Efficiency by zone"
          empty={<EmptyState message="No zone efficiency data for the current scope." />}
        />
      </ChartCard>
    </section>
  );
}
