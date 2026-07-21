import { useMemo } from 'react';
import { DateRangeChips, type Metric } from '../../components/data';
import { SlaBucketBarChart } from '../../components/charts/SlaBucketBarChart';
import { Badge } from '../../components/ui';
import { ActivityTrendSection } from './ActivityTrendSection';
import { CompanyPlantTable } from './CompanyPlantTable';
import { DashboardHero } from './DashboardHero';
import { EscalationQueueList } from './EscalationQueueList';
import { ScorecardTable } from './ScorecardTable';
import type { DashboardData } from './ZmDashboard';

/**
 * Cross-Zone Central Tower (FE-07, reference 03). The Central Service Manager's non-acting view: a
 * pan-zone KPI strip, the cross-zone Escalation Queue, the Zone Performance Scorecard, and the
 * Company/Plant overview — all over the existing role-scoped aggregations (CSM receives every zone).
 */
export function CentralDashboard({ zones, companyPlants, critical, actions, fleetUptime, zoneUptime, plantUptime, error }: DashboardData) {
  const metrics: Metric[] = useMemo(() => {
    const inactive = zones.reduce((s, z) => s + z.totalInactive, 0);
    const escalations = critical.reduce((s, g) => s + g.tickets.length, 0);
    const liveSources = actions.filter((a) => a.available && a.count > 0);
    const actionTotal = liveSources.reduce((s, a) => s + a.count, 0);
    return [
      {
        label: 'Fleet Uptime',
        value: fleetUptime != null ? `${fleetUptime.toFixed(1)}%` : '—',
        hint: fleetUptime != null ? 'this month, eligible devices' : 'awaiting Fleet Uptime run',
        tone: 'brand',
        hero: true,
        testId: 'kpi-uptime',
      },
      { label: 'Zones Covered', value: zones.length, hint: 'cross-zone scope', tone: 'info' },
      { label: 'Inactive Devices', value: inactive, hint: 'all zones', tone: 'warning' },
      { label: 'Escalations', value: escalations, hint: `${actionTotal} action items`, tone: 'critical' },
    ];
  }, [zones, critical, actions, fleetUptime]);

  return (
    <div>
      {/* Hero top section (docs/ui/hero-ref.jpg): 2 KPIs each side of the truck. */}
      <DashboardHero
        title="Cross-Zone Central Tower"
        actions={
          <>
            <Badge tone="success" dot>
              Snapshot Healthy
            </Badge>
            <DateRangeChips />
          </>
        }
        left={metrics.slice(0, 2)}
        right={metrics.slice(2, 4)}
      />
      {error && (
        <p role="alert" className="mb-4 text-sm text-critical">
          {error}
        </p>
      )}

      {/* Inactive vs Troubleshoot vs Installation over time (Issue 134) — Pan-India / Zone-wise. */}
      <ActivityTrendSection zones={zones.map((z) => ({ zoneId: z.zoneId, zoneName: z.zoneName }))} canSelectZone />

      {/* Same reference bar graph as the Ops-Head dashboard (uiDashboardSLA Bucket Distribution.jpg),
          over the cross-zone rows the CSM already receives. Rendered above the Escalation Queue —
          the queue can run to thousands of rows, and the fleet picture must stay above the fold. */}
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

      <EscalationQueueList groups={critical} />
      <ScorecardTable rows={zones} zoneUptime={zoneUptime} />
      <CompanyPlantTable rows={companyPlants} plantUptime={plantUptime} />
    </div>
  );
}
