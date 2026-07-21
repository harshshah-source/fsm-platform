import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DateRangeChips, RollingNumber, type Metric } from '../../components/data';
import { SlaBucketBarChart } from '../../components/charts/SlaBucketBarChart';
import { Badge } from '../../components/ui';
import { sumCriticalDevices } from '../../lib/slaBucket';
import { ActivityTrendSection } from './ActivityTrendSection';
import { CompanyPlantTable } from './CompanyPlantTable';
import { DashboardHero } from './DashboardHero';
import { onIngestionComplete } from './ingestionEvents';
import { ScorecardTable } from './ScorecardTable';
import type { DashboardData } from './ZmDashboard';

/**
 * Pan-India Fleet Command (FE-07, reference 04). The Operations-Head view: a dense pan-zone KPI strip,
 * the SLA Bucket Distribution heat-ramp, the Zone Performance Scorecard, and the Company/Plant overview
 * — all over the existing all-zone aggregations (no new endpoint).
 *
 * The Auto-Dispatch System Efficiency row (Auto-Dispatch Rate / Manual Intervention / On-Time Dispatch /
 * Avg Resolution) is removed pending a real backend source (System Efficiency report, BE-42) — no
 * placeholder chrome in the meantime.
 */
export function OpsHeadDashboard({ zones, companyPlants, fleet, fleetUptime, zoneUptime, plantUptime, error, onDataRefetch }: DashboardData) {
  const navigate = useNavigate();
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
    // Strictly the CRITICAL band (Issue 122) — same zone-overview source as the scorecard's Critical
    // column, so KPI == scorecard column sum by construction. Worse bands stay in the SLA distribution.
    const criticalDevices = sumCriticalDevices(zones);
    const roll = (value: number) => <RollingNumber value={value} runToken={lastRunAt} />;
    // The Action-Required card was replaced by the fleet counts (Issue 122b).
    return [
      {
        label: 'Fleet Uptime',
        value: fleetUptime != null ? `${fleetUptime.toFixed(1)}%` : '—',
        hint: fleetUptime != null ? 'this month, eligible devices' : 'awaiting Fleet Uptime run',
        tone: 'brand',
        hero: true,
        testId: 'kpi-uptime',
      },
      { label: 'Inactive Devices', value: roll(inactive), hint: `${zones.length} zones`, tone: 'warning' },
      { label: 'Critical Devices', value: roll(criticalDevices), hint: 'pan-India, CRITICAL band', tone: 'critical', testId: 'kpi-critical' },
      { label: 'Companies', value: fleet ? roll(fleet.companies) : '—', hint: 'pan-India', tone: 'info', testId: 'kpi-companies', onClick: () => navigate('/reports/fleet?tab=companies') },
      { label: 'Plants', value: fleet ? roll(fleet.plants) : '—', hint: 'with tracked devices', tone: 'info', testId: 'kpi-plants', onClick: () => navigate('/reports/fleet?tab=plants') },
      { label: 'Devices', value: fleet ? roll(fleet.devices) : '—', hint: 'tracked fleet', tone: 'brand', testId: 'kpi-devices', onClick: () => navigate('/reports/device') },
    ];
  }, [zones, fleet, fleetUptime, lastRunAt, navigate]);

  return (
    <div>
      {/* Hero top section (docs/ui/hero-ref.jpg): 3 KPIs each side of the truck. Same cards/testIds
          as the old flat strips. */}
      <DashboardHero
        title="Pan-India Fleet Command"
        actions={
          <>
            <Badge tone="success" dot>
              Snapshot Healthy
            </Badge>
            <DateRangeChips />
          </>
        }
        left={kpis.slice(0, 3)}
        right={kpis.slice(3, 6)}
      />
      {error && (
        <p role="alert" className="mb-4 text-sm text-critical">
          {error}
        </p>
      )}

      {/* Inactive vs Troubleshoot vs Installation over time (Issue 134) — between the KPI hero and the
          SLA Bucket Distribution. OH may switch Pan-India / Zone-wise + pick a zone. */}
      <ActivityTrendSection
        zones={zones.map((z) => ({ zoneId: z.zoneId, zoneName: z.zoneName }))}
        canSelectZone
      />

      <section aria-labelledby="sla-distribution-heading" className="mb-8">
        <h3
          id="sla-distribution-heading"
          className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-ink-caps"
        >
          SLA Bucket Distribution
        </h3>
        {/* Reference bar graph (uiDashboardSLA Bucket Distribution.jpg): per-zone bars grouped by
            bucket, semantic SLA colours, dashed average line, dark hover pill + count legend. */}
        <div className="rounded-card border border-line bg-surface-card p-4 shadow-sm">
          <SlaBucketBarChart zones={zones} />
        </div>
      </section>

      <ScorecardTable rows={zones} zoneUptime={zoneUptime} />
      <CompanyPlantTable rows={companyPlants} plantUptime={plantUptime} />
    </div>
  );
}
