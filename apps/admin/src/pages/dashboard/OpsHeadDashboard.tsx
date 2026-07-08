import { useCallback, useEffect, useMemo, useState } from 'react';
import { DateRangeChips, MetricStrip, PageHeader, RollingNumber, type Metric } from '../../components/data';
import { DistributionBar, type DistSegment } from '../../components/charts';
import { Badge } from '../../components/ui';
import { BUCKET_HEX, BUCKET_LABEL_RANGE, SLA_BUCKETS, sumCriticalPlusDevices } from '../../lib/slaBucket';
import { CompanyPlantTable } from './CompanyPlantTable';
import { onIngestionComplete } from './ingestionEvents';
import { ScorecardTable } from './ScorecardTable';
import type { DashboardData } from './ZmDashboard';

/**
 * Pan-India Fleet Command (FE-07, reference 04). The Operations-Head view: a dense pan-zone KPI strip,
 * the SLA Bucket Distribution heat-ramp, the Zone Performance Scorecard, and the Company/Plant overview
 * — all over the existing all-zone aggregations (no new endpoint).
 *
 * Documented omission (DESIGN-SYSTEM §9.2): the Auto-Dispatch System Efficiency row has no backend
 * source until the System Efficiency report (BE-42, surfaced by FE-24). Its cards render the reference
 * chrome with "—" placeholders rather than fabricated figures.
 */
export function OpsHeadDashboard({ zones, companyPlants, actions, error, onDataRefetch }: DashboardData) {
  // Bumped when a manual ingestion run completes AND its data refetch has resolved — the roll trigger
  // for the KPI odometers (keyed on completion, not on a value diff).
  const [lastRunAt, setLastRunAt] = useState<number | null>(null);

  const handleRunSuccess = useCallback(async () => {
    await onDataRefetch();
    setLastRunAt(Date.now());
  }, [onDataRefetch]);

  // The "Run Ingestion Now" trigger now lives in the top bar; it broadcasts on completion. Refetch the
  // KPI sources and bump the roll trigger whenever a manual run finishes.
  useEffect(() => onIngestionComplete(() => void handleRunSuccess()), [handleRunSuccess]);

  const kpis: Metric[] = useMemo(() => {
    const inactive = zones.reduce((s, z) => s + z.totalInactive, 0);
    // Device-based Critical+ (same zone-overview source as the scorecard) — equals the scorecard
    // Critical+ column sum by construction, never the open-ticket count (Issue 1).
    const criticalPlusDevices = sumCriticalPlusDevices(zones);
    const liveSources = actions.filter((a) => a.available && a.count > 0);
    const actionTotal = liveSources.reduce((s, a) => s + a.count, 0);
    const roll = (value: number) => <RollingNumber value={value} runToken={lastRunAt} />;
    return [
      { label: 'Fleet Uptime', value: '—', hint: 'Live with Fleet Uptime report', tone: 'brand' },
      { label: 'Inactive Devices', value: roll(inactive), hint: `${zones.length} zones`, tone: 'warning' },
      { label: 'Critical+ Devices', value: roll(criticalPlusDevices), hint: 'pan-India', tone: 'critical', testId: 'kpi-critical-plus' },
      { label: 'Action Required', value: roll(actionTotal), hint: `${liveSources.length} live sources`, tone: 'info' },
    ];
  }, [zones, actions, lastRunAt]);

  // Auto-Dispatch efficiency — gated on BE-42 / FE-24; reference chrome, no fabricated values.
  const efficiency: Metric[] = [
    { label: 'Auto-Dispatch Rate', value: '—', hint: 'System Efficiency (BE-42)', tone: 'success' },
    { label: 'Manual Intervention', value: '—', hint: 'System Efficiency (BE-42)', tone: 'warning' },
    { label: 'On-Time Dispatch', value: '—', hint: 'System Efficiency (BE-42)', tone: 'info' },
    { label: 'Avg Resolution', value: '—', hint: 'System Efficiency (BE-42)', tone: 'neutral' },
  ];

  // SLA Bucket Distribution — aggregate every zone's bucket counts into the heat-ramp.
  const segments: DistSegment[] = useMemo(
    () =>
      SLA_BUCKETS.map((b) => ({
        label: BUCKET_LABEL_RANGE[b],
        value: zones.reduce((s, z) => s + (z.byBucket[b] ?? 0), 0),
        color: BUCKET_HEX[b],
      })),
    [zones],
  );

  return (
    <div>
      <PageHeader
        title="Pan-India Fleet Command"
        subtitle="Nationwide fleet readiness, dispatch efficiency, and zone performance at a glance."
        actions={
          <>
            <Badge tone="success" dot>
              Snapshot Healthy
            </Badge>
            <DateRangeChips />
          </>
        }
      />
      {error && (
        <p role="alert" className="mb-4 text-sm text-critical">
          {error}
        </p>
      )}
      <MetricStrip metrics={kpis} />

      <section aria-labelledby="auto-dispatch-heading" className="mb-8">
        <h3
          id="auto-dispatch-heading"
          className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-ink-caps"
        >
          Auto-Dispatch System Efficiency
        </h3>
        <MetricStrip metrics={efficiency} className="mb-0" />
      </section>

      <section aria-labelledby="sla-distribution-heading" className="mb-8">
        <h3
          id="sla-distribution-heading"
          className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-ink-caps"
        >
          SLA Bucket Distribution
        </h3>
        <div className="rounded-card border border-line bg-surface-card p-4 shadow-sm">
          <DistributionBar segments={segments} />
        </div>
      </section>

      <ScorecardTable rows={zones} />
      <CompanyPlantTable rows={companyPlants} />
    </div>
  );
}
