import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  apiActionRequired,
  apiCompanyPlantOverview,
  apiCriticalQueue,
  apiZoneOverview,
  type ActionRequiredCard,
  type CompanyPlantRow,
  type CriticalQueueGroup,
  type ZoneOverviewRow,
} from '../../api/dashboard';
import { apiZoneEngineers, type ZoneEngineer } from '../../api/schedules';
import { DateRangeChips, MetricStrip, PageHeader, type Metric } from '../../components/data';
import { Badge } from '../../components/ui';
import { ActionRequiredPanel } from './ActionRequiredPanel';
import { CompanyPlantTable } from './CompanyPlantTable';
import { CriticalQueue } from './CriticalQueue';
import { ZoneOverviewTable } from './ZoneOverviewTable';

/**
 * Zone Operations Dashboard landing (Issue 06 · FE-06 parity). Composes the KPI MetricStrip, the
 * Action Required panel, Zone Overview, Company/Plant Overview, and the Grouped Critical Work Queue.
 * Role/zone scoping is enforced server-side (a ZM only ever receives their own zone; CSM / Operations
 * Head see all zones).
 *
 * FE-06 is a presentation-only refactor: the data loading, role scoping, assign wiring, and the test
 * selector contract are unchanged. The KPI strip derives its figures from the already-loaded dashboard
 * data — no new endpoint is introduced. Fleet Uptime % has no source until the Fleet Uptime report
 * (BE-39/40, surfaced by FE-21), so its card renders the reference chrome with a "—" placeholder.
 */
export function DashboardHome() {
  const [zones, setZones] = useState<ZoneOverviewRow[]>([]);
  const [companyPlants, setCompanyPlants] = useState<CompanyPlantRow[]>([]);
  const [critical, setCritical] = useState<CriticalQueueGroup[]>([]);
  const [actions, setActions] = useState<ActionRequiredCard[]>([]);
  const [engineers, setEngineers] = useState<ZoneEngineer[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([
      apiActionRequired(),
      apiZoneOverview(),
      apiCompanyPlantOverview(),
      apiCriticalQueue(),
    ])
      .then(([a, z, cp, cq]) => {
        if (!alive) return;
        setActions(a);
        setZones(z);
        setCompanyPlants(cp);
        setCritical(cq);
      })
      .catch(() => alive && setError('Failed to load dashboard'));
    // Zone-SE list feeds the Critical Queue assign picker; failure just leaves it empty.
    apiZoneEngineers()
      .then((e) => alive && setEngineers(e))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const refreshCritical = useCallback(() => {
    apiCriticalQueue()
      .then(setCritical)
      .catch(() => undefined);
  }, []);

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
      <CriticalQueue groups={critical} engineers={engineers} onAssigned={refreshCritical} />
    </div>
  );
}
