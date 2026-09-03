import { useMemo } from 'react';
import { DateRangeChips, type Metric } from '../../components/data';
import { SlaBucketBarChart } from '../../components/charts/SlaBucketBarChart';
import { SnapshotHealthBadge } from '../../components/dashboard/SnapshotHealthBadge';
import { ZoneOperatingModeTable } from '../../components/dashboard/ZoneOperatingModeTable';
import { formatCount } from '../../lib/fleetFormat';
import { ActionRequiredPanel } from './ActionRequiredPanel';
import { ActivityTrendSection } from './ActivityTrendSection';
import { CompanyPlantTable } from './CompanyPlantTable';
import { DashboardHero } from './DashboardHero';
import { EscalationQueueList } from './EscalationQueueList';
import { OperationalFleetSection } from './OperationalFleetSection';
import { ScorecardTable } from './ScorecardTable';
import type { DashboardData } from './ZmDashboard';

/**
 * Cross-Zone Central Tower (FE-07, reference 03). The Central Service Manager's non-acting view: a
 * pan-zone KPI strip, the cross-zone Escalation Queue, the Zone Performance Scorecard, and the
 * Company/Plant overview — all over the existing role-scoped aggregations (CSM receives every zone).
 */
export function CentralDashboard({ zones, companyPlants, critical, actions, fleet, fleetUptime, zoneUptime, plantUptime, error }: DashboardData) {
  const metrics: Metric[] = useMemo(() => {
    // Same operational source as the scorecard column below it.
    const inactive = zones.reduce((s, z) => s + z.inactiveOperational, 0);
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
        kpi: 'fleetUptime',
        testId: 'kpi-uptime',
      },
      { label: 'Zones Covered', value: zones.length, hint: 'cross-zone scope', tone: 'info' },
      {
        label: 'Inactive Operational Devices',
        value: formatCount(inactive),
        hint: 'all zones',
        tone: 'warning',
        kpi: 'inactiveOperational',
        testId: 'kpi-inactive-operational-hero',
      },
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
            <SnapshotHealthBadge />
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

      <OperationalFleetSection fleet={fleet} />

      {/* Inactive vs Troubleshoot vs Installation over time (Issue 134) — Pan-India / Zone-wise. */}
      <ActivityTrendSection zones={zones.map((z) => ({ zoneId: z.zoneId, zoneName: z.zoneName }))} canSelectZone />

      {/* #350 — the panel the CSM never had. The KPI strip above already totals these cards into
          "N action items", so the page named a number it then refused to itemise, and the one role
          that covers every zone could not see what any of them was waiting on. Pan-India: the CSM's
          scope is every zone and the endpoint answers unscoped unless a zone is named (B5), which is
          the same posture as the Escalation Queue and Scorecard below. Placed exactly where the ZM
          dashboard places it — after the trend, above the SLA distribution — so the two pages read
          the same way to a CSM who moves between them by acting as ZM. */}
      <ActionRequiredPanel cards={actions} />

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

      {/* #136 slice 3, mounted at last (#351 AC3) — every zone's recommender mode, worst-first.
          Directly above the Zone Performance Scorecard, because the two answer adjacent questions
          about the same five rows: what mode each zone is running in, and how each is performing. */}
      <div className="mb-6">
        <ZoneOperatingModeTable />
      </div>

      <ScorecardTable rows={zones} zoneUptime={zoneUptime} />
      <CompanyPlantTable rows={companyPlants} plantUptime={plantUptime} />
    </div>
  );
}
