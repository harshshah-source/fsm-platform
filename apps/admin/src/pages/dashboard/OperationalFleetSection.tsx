import { useMemo } from 'react';
import type { FleetSummary } from '../../api/dashboard';
import { MetricStrip, type Metric } from '../../components/data';
import { formatCount, formatPct, formatStamp } from '../../lib/fleetFormat';

/**
 * The Operational Fleet KPI section — the six numbers that describe the fleet FSM actually tracks,
 * all over ONE population and all reconciling exactly with the Zone and Company tables below.
 *
 *   Operational = Healthy + Inactive          (the split)
 *   Operational + Warehouse = Mirrored        (warehouse reconciles separately, never inside a rate)
 *   Fleet Health % + Inactive % = 100%        (both against the operational denominator)
 *
 * Deliberately separate from the KPI hero above it, which mixes families: the hero carries Fleet
 * Uptime (a monthly report), Critical Devices (a band of the inactive count) and the AutoPlant Catalog
 * (another system's inventory). This strip is the one place where every card is the same kind of thing
 * measured the same way, so the numbers can be added up on sight.
 */
export function OperationalFleetSection({ fleet }: { fleet: FleetSummary | null }) {
  const metrics: Metric[] = useMemo(() => {
    const v = (n: number | null | undefined) => (fleet ? formatCount(n) : '—');
    const p = (n: number | null | undefined) => (fleet ? formatPct(n) : '—');
    return [
      {
        label: 'Operational Devices',
        value: v(fleet?.operationalDevices),
        hint: 'deployed & tracked by FSM',
        tone: 'brand',
        kpi: 'operationalDevices',
        testId: 'kpi-operational-devices',
      },
      {
        label: 'Healthy Operational',
        value: v(fleet?.healthyOperational),
        hint: 'reporting normally',
        tone: 'success',
        kpi: 'healthyOperational',
        testId: 'kpi-healthy-devices',
      },
      {
        label: 'Inactive Operational',
        value: v(fleet?.inactiveOperational),
        hint: 'silent past the threshold',
        tone: 'warning',
        kpi: 'inactiveOperational',
        testId: 'kpi-inactive-operational',
      },
      {
        label: 'Warehouse Devices',
        value: v(fleet?.warehouseDevices),
        hint: 'removed from field ops',
        tone: 'neutral',
        kpi: 'warehouseDevices',
        testId: 'kpi-warehouse-devices',
      },
      {
        label: 'Fleet Health %',
        value: p(fleet?.fleetHealthPct),
        hint: 'healthy ÷ operational',
        tone: 'success',
        kpi: 'fleetHealthPct',
        testId: 'kpi-fleet-health-pct',
      },
      {
        label: 'Inactive %',
        value: p(fleet?.inactivePct),
        hint: 'inactive ÷ operational',
        tone: 'critical',
        kpi: 'inactivePct',
        testId: 'kpi-inactive-pct',
      },
    ];
  }, [fleet]);

  return (
    <section aria-labelledby="operational-fleet-heading" className="mb-8">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="operational-fleet-heading" className="text-[11px] font-semibold uppercase tracking-wider text-ink-caps">
          Operational Fleet
        </h3>
        {/* The freshness of every count in this strip. A manager reading "0 inactive" needs to know
            whether that is good news or a stalled snapshot. */}
        <p className="text-xs text-ink-muted" data-testid="operational-fleet-freshness">
          Last snapshot: <span className="tabular-nums text-ink">{formatStamp(fleet?.lastSnapshotAt)}</span>
        </p>
      </div>
      <MetricStrip metrics={metrics} cols={6} className="mb-0" />
      <p className="mt-2 text-xs text-ink-muted">
        Operational = Healthy + Inactive. Warehouse devices sit outside every rate above and reconcile
        separately. These six figures are the column totals of the Zone and Company tables below.
      </p>
    </section>
  );
}
