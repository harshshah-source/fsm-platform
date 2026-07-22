import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type {
  ActionRequiredCard,
  CompanyPlantRow,
  CriticalQueueGroup,
  FleetSummary,
  ZoneOverviewRow,
} from '../../api/dashboard';
import type { ZoneEngineer } from '../../api/schedules';
import { DateRangeChips, type Metric } from '../../components/data';
import { SlaBucketBarChart } from '../../components/charts/SlaBucketBarChart';
import { ZoneOperatingModeCard } from '../../components/dashboard/ZoneOperatingModeCard';
import { Badge } from '../../components/ui';
import { sumCriticalDevices } from '../../lib/slaBucket';
import { ActionRequiredPanel } from './ActionRequiredPanel';
import { ActivityTrendSection } from './ActivityTrendSection';
import { CompanyPlantTable } from './CompanyPlantTable';
import { DashboardHero } from './DashboardHero';
import { ZoneOverviewTable } from './ZoneOverviewTable';

export interface DashboardData {
  zones: ZoneOverviewRow[];
  companyPlants: CompanyPlantRow[];
  critical: CriticalQueueGroup[];
  actions: ActionRequiredCard[];
  /** Headline fleet counts (Issue 122b); null until loaded (or on an older backend). */
  fleet: FleetSummary | null;
  /** Current-month fleet uptime % (BE-39 Fleet Uptime report); null until loaded / no computed data. */
  fleetUptime: number | null;
  /** Per-zone current-month uptime %, keyed by zoneId — powers the Scorecard's Fleet Uptime column. */
  zoneUptime?: Map<string, number>;
  /** Per-plant current-month uptime %, keyed by plantId — Company/Plant Overview Fleet Uptime % (Issue 135). */
  plantUptime?: Map<string, number>;
  engineers: ZoneEngineer[];
  error: string | null;
  onAssigned: () => void;
  /** Refetch the KPI data sources (zone-overview / action-required). Resolves once state is updated. */
  onDataRefetch: () => Promise<void>;
}

/**
 * Zone Operations Dashboard body (Issue 06 / FE-06, reference 01). The default variant for a Zonal
 * Manager — and for a CSM / Operations Head acting as ZM in a zone (the amber Backup-Coverage banner is
 * rendered by the shell, Issue 27). Receives the already-loaded, server-scoped data from `DashboardHome`.
 */
export function ZmDashboard({
  zones,
  companyPlants,
  actions,
  fleet,
  fleetUptime,
  plantUptime,
  error,
}: DashboardData) {
  const navigate = useNavigate();
  // KPI strip derived from already-loaded data. Uptime comes from the Fleet Uptime report (BE-39). The
  // Action-Required card was replaced by the fleet counts (Issue 122b) — its queue lives on in the panel below.
  const nf = useMemo(() => new Intl.NumberFormat('en-IN'), []);
  const metrics: Metric[] = useMemo(() => {
    const inactive = zones.reduce((s, z) => s + z.totalInactive, 0);
    // Strictly the CRITICAL band (Issue 122) — same device-based source as the scorecard's Critical
    // column, so KPI == scorecard column sum by construction. Worse bands stay in the Zone Overview.
    const criticalDevices = sumCriticalDevices(zones);
    return [
      {
        label: 'Fleet Uptime',
        value: fleetUptime != null ? `${fleetUptime.toFixed(1)}%` : '—',
        hint: fleetUptime != null ? 'this month, eligible devices' : 'awaiting Fleet Uptime run',
        tone: 'brand',
        hero: true,
        testId: 'kpi-uptime',
      },
      {
        label: 'Inactive Devices',
        value: inactive,
        hint: `across ${zones.length} zone${zones.length === 1 ? '' : 's'}`,
        tone: 'warning',
      },
      {
        label: 'Critical Devices',
        value: criticalDevices,
        hint: 'in the CRITICAL band',
        tone: 'critical',
        testId: 'kpi-critical',
      },
      { label: 'Companies', value: fleet ? nf.format(fleet.companies) : '—', hint: 'in your scope', tone: 'info', testId: 'kpi-companies', onClick: () => navigate('/reports/fleet?tab=companies') },
      { label: 'Plants', value: fleet ? nf.format(fleet.plants) : '—', hint: 'with tracked devices', tone: 'info', testId: 'kpi-plants', onClick: () => navigate('/reports/fleet?tab=plants') },
      { label: 'Active Fleet', value: fleet ? nf.format(fleet.devices) : '—', hint: 'deployed devices', tone: 'brand', testId: 'kpi-devices', onClick: () => navigate('/reports/device') },
    ];
  }, [zones, fleet, fleetUptime, nf, navigate]);

  return (
    <div>
      {/* Hero top section (docs/ui/hero-ref.jpg): 3 KPIs each side of the truck. */}
      <DashboardHero
        title="Zone Operations Dashboard"
        actions={
          <>
            <Badge tone="success" dot>
              Snapshot Healthy
            </Badge>
            <DateRangeChips />
          </>
        }
        left={metrics.slice(0, 3)}
        right={metrics.slice(3, 6)}
      />
      {error && (
        <p role="alert" className="mb-4 text-sm text-critical">
          {error}
        </p>
      )}

      {/* Inactive vs Troubleshoot vs Installation over time (Issue 134), scoped to the ZM's own zone
          (the backend clamps) — between the KPI hero and the SLA Bucket Distribution. */}
      <ActivityTrendSection zones={zones.map((z) => ({ zoneId: z.zoneId, zoneName: z.zoneName }))} canSelectZone={false} />

      {/* Zone operating mode (Issue 136) — plain-language "Catch-up / Steady" + why, for this ZM's zone. */}
      <div className="mb-8">
        <ZoneOperatingModeCard />
      </div>

      <ActionRequiredPanel cards={actions} />

      {/* Same reference bar graph as the Ops-Head dashboard (uiDashboardSLA Bucket Distribution.jpg),
          over the zone-scoped rows the ZM already receives. */}
      <section aria-labelledby="sla-distribution-heading" className="mb-8">
        <h3
          id="sla-distribution-heading"
          className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-ink-caps"
        >
          SLA Bucket Distribution
        </h3>
        <div className="rounded-card border border-line bg-surface-card p-4 shadow-sm">
          <SlaBucketBarChart zones={zones} />
        </div>
      </section>

      <ZoneOverviewTable rows={zones} />
      <CompanyPlantTable rows={companyPlants} plantUptime={plantUptime} />
    </div>
  );
}
