import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RollingNumber, type Metric } from '../../components/data';
import { SlaBucketBarChart } from '../../components/charts/SlaBucketBarChart';
import { ZoneOperatingModeTable } from '../../components/dashboard/ZoneOperatingModeTable';
import { ActivityTrendSection } from './ActivityTrendSection';
import { CompanyPlantTable } from './CompanyPlantTable';
import { DashboardHero } from './DashboardHero';
import { onIngestionComplete } from './ingestionEvents';
import { ScorecardTable } from './ScorecardTable';
import type { DashboardData } from './ZmDashboard';
function CompanyPlantCard({ companies, plants, onCompaniesClick, onPlantsClick }: { companies: React.ReactNode; plants: React.ReactNode; onCompaniesClick: () => void; onPlantsClick: () => void }) {
  return (
    <div className="relative overflow-hidden rounded-card border border-white/60 bg-gradient-to-br from-info/15 to-surface-card/75 p-4 shadow-card backdrop-blur-md before:absolute before:inset-y-0 before:left-0 before:w-1 before:rounded-l-card before:bg-info">
      <div className="grid grid-cols-2 divide-x divide-line/70 pl-1.5">
        <button type="button" data-testid="kpi-companies" onClick={onCompaniesClick} className="pr-3 text-left focus-ring">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-caps">Companies</div>
          <div className="mt-1 text-2xl font-bold tracking-tight text-ink-strong">{companies}</div>
          <div className="mt-0.5 text-xs text-ink-muted">pan-India</div>
        </button>
        <button type="button" data-testid="kpi-plants" onClick={onPlantsClick} className="pl-3 text-left focus-ring">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-caps">Plants</div>
          <div className="mt-1 text-2xl font-bold tracking-tight text-ink-strong">{plants}</div>
          <div className="mt-0.5 text-xs text-ink-muted">with tracked devices</div>
        </button>
      </div>
    </div>
  );
}

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
      { label: 'Active Fleet', value: fleet ? roll(fleet.devices) : '—', hint: 'deployed devices', tone: 'brand', testId: 'kpi-devices', onClick: () => navigate('/reports/device') },
      {
        label: 'Total Devices',
        value: fleet && fleet.sourceDevices != null ? roll(fleet.sourceDevices) : '—',
        hint: 'AutoPlant catalog · pan-India',
        tone: 'info',
        testId: 'kpi-total-devices',
      },
    ];
  }, [zones, fleet, fleetUptime, lastRunAt, navigate]);

  return (
    <div>
      {/* Hero top section (docs/ui/hero-ref.jpg): 3 KPIs each side of the truck. Same cards/testIds
          as the old flat strips. */}
      <DashboardHero
        title="Pan-India Fleet Command"
        left={kpis.slice(0, 2)}
        right={[
          {
            label: 'Fleet directory',
            value: (
              <CompanyPlantCard
                companies={fleet ? <RollingNumber value={fleet.companies} runToken={lastRunAt} /> : '—'}
                plants={fleet ? <RollingNumber value={fleet.plants} runToken={lastRunAt} /> : '—'}
                onCompaniesClick={() => navigate('/reports/fleet?tab=companies')}
                onPlantsClick={() => navigate('/reports/fleet?tab=plants')}
              />
            ),
          },
          kpis[2],
          kpis[3],
        ]}
        centerBelow={
          <ActivityTrendSection zones={zones.map((z) => ({ zoneId: z.zoneId, zoneName: z.zoneName }))} canSelectZone compact />
        }
      />
      {error && (
        <p role="alert" className="mb-4 text-sm text-critical">
          {error}
        </p>
      )}


      {/* Cross-zone operating mode (Issue 136) — every zone's Catch-up / Steady status, sortable. */}
      <div className="mb-8">
        <ZoneOperatingModeTable />
      </div>

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

