import { useMemo } from 'react';
import type {
  ActionRequiredCard,
  CompanyPlantRow,
  CriticalQueueGroup,
  ZoneOverviewRow,
} from '../../api/dashboard';
import type { ZoneEngineer } from '../../api/schedules';
import { DateRangeChips, MetricStrip, PageHeader, type Metric } from '../../components/data';
import { Badge } from '../../components/ui';
import { ActionRequiredPanel } from './ActionRequiredPanel';
import { CompanyPlantTable } from './CompanyPlantTable';
import { CriticalQueue } from './CriticalQueue';
import { ZoneOverviewTable } from './ZoneOverviewTable';

export interface DashboardData {
  zones: ZoneOverviewRow[];
  companyPlants: CompanyPlantRow[];
  critical: CriticalQueueGroup[];
  actions: ActionRequiredCard[];
  engineers: ZoneEngineer[];
  error: string | null;
  onAssigned: () => void;
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
  engineers,
  error,
  onAssigned,
}: DashboardData) {
  // KPI strip derived from already-loaded data (no new endpoint). Uptime is gated on BE-39/40.
  const metrics: Metric[] = useMemo(() => {
    const inactive = zones.reduce((s, z) => s + z.totalInactive, 0);
    const criticalCount = critical.reduce((s, g) => s + g.tickets.length, 0);
    const liveSources = actions.filter((a) => a.available && a.count > 0);
    const actionTotal = liveSources.reduce((s, a) => s + a.count, 0);
    return [
      { label: 'Fleet Uptime', value: '—', hint: 'Live with Fleet Uptime report', tone: 'brand' },
      {
        label: 'Inactive Devices',
        value: inactive,
        hint: `across ${zones.length} zone${zones.length === 1 ? '' : 's'}`,
        tone: 'warning',
      },
      {
        label: 'Critical+ Tickets',
        value: criticalCount,
        hint: `${critical.length} plant cluster${critical.length === 1 ? '' : 's'}`,
        tone: 'critical',
      },
      {
        label: 'Action Required',
        value: actionTotal,
        hint: `${liveSources.length} live source${liveSources.length === 1 ? '' : 's'}`,
        tone: 'info',
      },
    ];
  }, [zones, critical, actions]);

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
      <MetricStrip metrics={metrics} />
      <ActionRequiredPanel cards={actions} />
      <ZoneOverviewTable rows={zones} />
      <CompanyPlantTable rows={companyPlants} />
      <CriticalQueue groups={critical} engineers={engineers} onAssigned={onAssigned} />
    </div>
  );
}
