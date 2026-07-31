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
import { Badge } from '../../components/ui';
import { formatCount } from '../../lib/fleetFormat';
import { sumCriticalDevices } from '../../lib/slaBucket';
import { ActionRequiredPanel } from './ActionRequiredPanel';
import { ActivityTrendSection } from './ActivityTrendSection';
import { CompanyPlantTable } from './CompanyPlantTable';
import { DashboardHero } from './DashboardHero';
import { OperationalFleetSection } from './OperationalFleetSection';
import { ZoneOverviewTable } from './ZoneOverviewTable';

export interface DashboardData {
  zones: ZoneOverviewRow[];
  companyPlants: CompanyPlantRow[];
  critical: CriticalQueueGroup[];
  actions: ActionRequiredCard[];
  /** Headline fleet counts; null until loaded (or on an older backend). */
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
  // KPI strip derived from already-loaded data. Uptime comes from the Fleet Uptime report (BE-39); the
  // Action-Required queue lives on in the panel below.
  const metrics: Metric[] = useMemo(() => {
    // Read straight off the zone rows, which now carry the operational breakdown — so this card and the
    // "Inactive Operational" column beneath it are the same number by construction.
    const inactive = zones.reduce((s, z) => s + z.inactiveOperational, 0);
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
        kpi: 'fleetUptime',
        testId: 'kpi-uptime',
      },
      {
        label: 'Inactive Operational Devices',
        value: formatCount(inactive),
        hint: `across ${zones.length} zone${zones.length === 1 ? '' : 's'}`,
        tone: 'warning',
        kpi: 'inactiveOperational',
        testId: 'kpi-inactive-operational-hero',
      },
      {
        label: 'Critical Devices',
        value: formatCount(criticalDevices),
        hint: 'in the CRITICAL band',
        tone: 'critical',
        kpi: 'criticalDevices',
        testId: 'kpi-critical',
      },
      { label: 'Companies', value: fleet ? formatCount(fleet.companies) : '—', hint: 'in your scope', tone: 'info', kpi: 'companies', testId: 'kpi-companies', onClick: () => navigate('/reports/fleet?tab=companies') },
      { label: 'Plants', value: fleet ? formatCount(fleet.plants) : '—', hint: 'with tracked devices', tone: 'info', kpi: 'plants', testId: 'kpi-plants', onClick: () => navigate('/reports/fleet?tab=plants') },
      { label: 'Operational Fleet', value: fleet ? formatCount(fleet.operationalDevices) : '—', hint: 'deployed & tracked', tone: 'brand', kpi: 'operationalDevices', testId: 'kpi-devices', onClick: () => navigate('/reports/device') },
    ];
  }, [zones, fleet, fleetUptime, navigate]);

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

      {/* The one strip where every card is the same kind of number, and the column totals of the two
          tables at the bottom of the page. */}
      <OperationalFleetSection fleet={fleet} />

      {/* Inactive vs Troubleshoot vs Installation over time (Issue 134), scoped to the ZM's own zone
          (the backend clamps) — between the KPI hero and the SLA Bucket Distribution. */}
      <ActivityTrendSection zones={zones.map((z) => ({ zoneId: z.zoneId, zoneName: z.zoneName }))} canSelectZone={false} />

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
