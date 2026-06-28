import { useMemo } from 'react';
import { DateRangeChips, MetricStrip, PageHeader, type Metric } from '../../components/data';
import { Badge } from '../../components/ui';
import { CompanyPlantTable } from './CompanyPlantTable';
import { EscalationQueueList } from './EscalationQueueList';
import { ScorecardTable } from './ScorecardTable';
import type { DashboardData } from './ZmDashboard';

/**
 * Cross-Zone Central Tower (FE-07, reference 03). The Central Service Manager's non-acting view: a
 * pan-zone KPI strip, the cross-zone Escalation Queue, the Zone Performance Scorecard, and the
 * Company/Plant overview — all over the existing role-scoped aggregations (CSM receives every zone).
 */
export function CentralDashboard({ zones, companyPlants, critical, actions, error }: DashboardData) {
  const metrics: Metric[] = useMemo(() => {
    const inactive = zones.reduce((s, z) => s + z.totalInactive, 0);
    const escalations = critical.reduce((s, g) => s + g.tickets.length, 0);
    const liveSources = actions.filter((a) => a.available && a.count > 0);
    const actionTotal = liveSources.reduce((s, a) => s + a.count, 0);
    return [
      { label: 'Fleet Uptime', value: '—', hint: 'Live with Fleet Uptime report', tone: 'brand' },
      { label: 'Zones Covered', value: zones.length, hint: 'cross-zone scope', tone: 'info' },
      { label: 'Inactive Devices', value: inactive, hint: 'all zones', tone: 'warning' },
      { label: 'Escalations', value: escalations, hint: `${actionTotal} action items`, tone: 'critical' },
    ];
  }, [zones, critical, actions]);

  return (
    <div>
      <PageHeader
        title="Cross-Zone Central Tower"
        subtitle="Pan-zone escalations, zone performance, and fleet load across every zone you cover."
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
      <EscalationQueueList groups={critical} />
      <ScorecardTable rows={zones} />
      <CompanyPlantTable rows={companyPlants} />
    </div>
  );
}
