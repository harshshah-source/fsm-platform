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
import { DateRangeChips, MetricStrip, PageHeader, type Metric } from '../../components/data';
import { Badge } from '../../components/ui';
import { sumCriticalDevices } from '../../lib/slaBucket';
import { ActionRequiredPanel } from './ActionRequiredPanel';
import { CompanyPlantTable } from './CompanyPlantTable';
import { CriticalQueue } from './CriticalQueue';
import { ZoneOverviewTable } from './ZoneOverviewTable';

export interface DashboardData {
  zones: ZoneOverviewRow[];
  companyPlants: CompanyPlantRow[];
  critical: CriticalQueueGroup[];
  actions: ActionRequiredCard[];
  /** Headline fleet counts (Issue 122b); null until loaded (or on an older backend). */
  fleet: FleetSummary | null;
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
  critical,
  actions,
  fleet,
  engineers,
  error,
  onAssigned,
}: DashboardData) {
  const navigate = useNavigate();
  // KPI strip derived from already-loaded data. Uptime is gated on BE-39/40. The Action-Required
  // card was replaced by the fleet counts (Issue 122b) — its queue lives on in the panel below.
  const nf = useMemo(() => new Intl.NumberFormat('en-IN'), []);
  const metrics: Metric[] = useMemo(() => {
    const inactive = zones.reduce((s, z) => s + z.totalInactive, 0);
    // Strictly the CRITICAL band (Issue 122) — same device-based source as the scorecard's Critical
    // column, so KPI == scorecard column sum by construction. Worse bands stay in the Zone Overview.
    const criticalDevices = sumCriticalDevices(zones);
    return [
      { label: 'Fleet Uptime', value: '—', hint: 'Live with Fleet Uptime report', tone: 'brand', hero: true },
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
      { label: 'Devices', value: fleet ? nf.format(fleet.devices) : '—', hint: 'tracked fleet', tone: 'brand', testId: 'kpi-devices', onClick: () => navigate('/reports/device') },
    ];
  }, [zones, fleet, nf, navigate]);

  return (
    <div>
      <PageHeader
        title="Zone Operations Dashboard"
        subtitle="Live fleet readiness, action queue, and CRITICAL+ work for your zone."
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
      <MetricStrip metrics={metrics} cols={6} />
      <ActionRequiredPanel cards={actions} />
      <ZoneOverviewTable rows={zones} />
      <CompanyPlantTable rows={companyPlants} />
      <CriticalQueue groups={critical} engineers={engineers} onAssigned={onAssigned} />
    </div>
  );
}
