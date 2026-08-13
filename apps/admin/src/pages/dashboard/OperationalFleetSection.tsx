import { useMemo } from 'react';
import type { FleetSummary } from '../../api/dashboard';
import { MetricStrip, type Metric } from '../../components/data';
import { formatCount, formatPct, formatStamp } from '../../lib/fleetFormat';

/**
 * The Operational Fleet KPI section — the numbers that describe the fleet FSM actually tracks, all
 * over ONE population and all reconciling exactly with the Zone and Company tables below.
 *
 *   Operational = Healthy + Inactive + Never Reported   (the split — THREE states since #223)
 *   Operational + Warehouse = Mirrored                  (warehouse reconciles separately, never in a rate)
 *   Fleet Health % + Inactive % = 100%                  (both against the REPORTING denominator)
 *
 * **Never Reported is a card here rather than a fifth tile in the hero above** — operator decision P4
 * asked for the never-reported count to be its own figure, and this strip is where the fleet's counts
 * already live and already add up on sight. Putting it in the hero would have meant redesigning the
 * 4-tile layout the authoritative reference (`docs/ui/desktop/v2-reference/04-dashboard-operations-head.png`)
 * fixes, to show a number that belongs with its siblings rather than with Fleet Uptime and Auto-Dispatch.
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
        // #223 — the third state. `critical` rather than `warning`: a tracker that has never reported
        // once is a worse condition than one that reported and went quiet, and 66% of them have been
        // fitted for over a year. It reads next to Inactive so the two are compared, not conflated.
        label: 'Never Reported',
        value: v(fleet?.neverReported),
        hint: 'no GPS fix, ever',
        tone: 'critical',
        kpi: 'neverReported',
        testId: 'kpi-never-reported',
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
        hint: 'healthy ÷ reporting',
        tone: 'success',
        kpi: 'fleetHealthPct',
        testId: 'kpi-fleet-health-pct',
      },
      {
        label: 'Inactive %',
        value: p(fleet?.inactivePct),
        hint: 'inactive ÷ reporting',
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
      {/* 4-up: seven figures across six columns would leave one orphaned on its own row at every
          breakpoint. Two rows of four (the last slot empty) keeps the counts on the top row and the
          two rates below them, which is also how they are read — and `flat` makes the two rows one
          KPI grid, ruled between rows, instead of seven separate cards. */}
      <MetricStrip metrics={metrics} cols={4} flat className="mb-0" />
      <p className="mt-2 text-xs text-ink-muted">
        Operational = Healthy + Inactive + Never Reported. Both rates are taken over devices that have
        reported at least once, so a tracker that has never sent a fix is counted beside Fleet Health
        rather than inside it. Warehouse devices sit outside every rate and reconcile separately. These
        figures are the column totals of the Zone and Company tables below.
      </p>
    </section>
  );
}
