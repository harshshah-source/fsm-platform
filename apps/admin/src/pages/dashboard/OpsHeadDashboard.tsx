import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RollingNumber, type Metric } from '../../components/data';
import { SlaBucketBarChart } from '../../components/charts/SlaBucketBarChart';
import { formatStamp } from '../../lib/fleetFormat';
import { sumCriticalDevices } from '../../lib/slaBucket';
import { ActivityTrendSection } from './ActivityTrendSection';
import { CompanyPlantTable } from './CompanyPlantTable';
import { DashboardHero } from './DashboardHero';
import { onIngestionComplete } from './ingestionEvents';
import { OperationalFleetSection } from './OperationalFleetSection';
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
    // Read off the zone rows' operational breakdown, so this card and the "Inactive Operational"
    // column in the scorecard below are the same number by construction.
    const inactive = zones.reduce((s, z) => s + z.inactiveOperational, 0);
    const roll = (value: number) => <RollingNumber value={value} runToken={lastRunAt} />;
    return [
      {
        label: 'Fleet Uptime',
        value: fleetUptime != null ? `${fleetUptime.toFixed(1)}%` : '—',
        hint: fleetUptime != null ? 'this month, eligible devices' : 'awaiting Fleet Uptime run',
        tone: 'brand',
        hero: true,
        kpi: 'fleetUptime',
        testId: 'kpi-uptime',
      },
      {
        label: 'Inactive Operational Devices',
        value: roll(inactive),
        hint: `${zones.length} zones`,
        tone: 'warning',
        kpi: 'inactiveOperational',
        testId: 'kpi-inactive-operational-hero',
      },
      // Strictly the CRITICAL band (Issue 122 HITL decision) — same zone-overview `byBucket` source as
      // the scorecard's "Inactive > 24Hr" column, which is deliberately a SUPERSET (CRITICAL + worse).
      // Removed in error by ad03769's hero rework and restored by #143; the guarding test
      // (kpi-critical-plus-consistency) was left in place and red for 3 commits. Do not drop this card
      // without reversing the Issue-122 decision in INDEX and the #122 issue file.
      {
        label: 'Critical Devices',
        value: roll(sumCriticalDevices(zones)),
        hint: 'pan-India, CRITICAL band',
        tone: 'critical',
        kpi: 'criticalDevices',
        testId: 'kpi-critical',
      },
      {
        label: 'Operational Fleet',
        value: fleet ? roll(fleet.operationalDevices) : '—',
        hint: 'deployed & tracked by FSM',
        tone: 'brand',
        kpi: 'operationalDevices',
        testId: 'kpi-devices',
        onClick: () => navigate('/reports/device'),
      },
      {
        // Renamed from "Total Devices": it is NOT a total of anything FSM tracks — it is another
        // system's catalog, at another moment, including devices FSM deliberately never mirrors.
        // Sitting unlabelled beside the operational counts, it invited exactly the subtraction that
        // started this rework. The sync stamp is part of the card for the same reason.
        label: 'AutoPlant Catalog',
        value: fleet && fleet.catalogDevices != null ? roll(fleet.catalogDevices) : '—',
        hint: (
          <span data-testid="kpi-catalog-sync">
            Last sync: <span className="tabular-nums">{formatStamp(fleet?.lastMasterSyncAt)}</span>
          </span>
        ),
        tone: 'info',
        kpi: 'autoplantCatalog',
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
        left={kpis.slice(0, 3)}
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
          kpis[3],
          kpis[4],
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


      {/* The one strip where every card is the same kind of number, and the column totals of the
          Scorecard and Company/Plant tables further down. */}
      <OperationalFleetSection fleet={fleet} />

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

