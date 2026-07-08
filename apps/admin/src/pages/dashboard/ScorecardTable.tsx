import type { ZoneOverviewRow } from '../../api/dashboard';
import { DataTable, type Column } from '../../components/data';
import { SLABadge } from '../../components/domain';
import { criticalPlusCount, SLA_BUCKETS, type SlaBucket } from '../../lib/slaBucket';
import { formatInactiveOfTotal } from '../../lib/inactiveDuration';

/** Worst (most-severe non-zero) bucket in a zone — `SLA_BUCKETS` is in descending severity order. */
function worstBucket(byBucket: Record<string, number>): SlaBucket | null {
  return SLA_BUCKETS.find((b) => (byBucket[b] ?? 0) > 0) ?? null;
}

/**
 * Zone Performance Scorecard (FE-07, reference 03/04). A cross-zone league table derived from the
 * existing `zone-overview` aggregation — no new endpoint. Shared by the Central Tower and Pan-India
 * Fleet Command variants. The richer performance analytics (resolution %, SLA attainment) are owned by
 * the ZM Performance Scorecard report (FE-25 / BE-43); this dashboard view ranks zones by live load.
 */
export function ScorecardTable({ rows }: { rows: ZoneOverviewRow[] }) {
  const columns: Column<ZoneOverviewRow>[] = [
    {
      key: 'zone',
      header: 'Zone',
      render: (r) => <span className="font-medium text-ink-strong">{r.zoneName}</span>,
      sortable: true,
      sortValue: (r) => r.zoneName,
    },
    {
      key: 'total',
      header: 'Inactive / Total',
      align: 'right',
      render: (r) => (
        <span data-testid="scorecard-inactive-total" className="tabular-nums">
          {formatInactiveOfTotal(r.totalInactive, r.totalDevices)}
        </span>
      ),
      sortable: true,
      sortValue: (r) => r.totalInactive,
    },
    {
      key: 'critical',
      header: 'Critical+',
      align: 'right',
      render: (r) => (
        <span data-testid="scorecard-critical-plus" className="tabular-nums font-semibold text-critical">
          {criticalPlusCount(r.byBucket)}
        </span>
      ),
      sortable: true,
      sortValue: (r) => criticalPlusCount(r.byBucket),
    },
    {
      key: 'worst',
      header: 'Worst Bucket',
      align: 'right',
      render: (r) => {
        const w = worstBucket(r.byBucket);
        return w ? <SLABadge bucket={w} /> : <span className="text-ink-muted">—</span>;
      },
    },
  ];

  return (
    <section aria-labelledby="scorecard-heading" className="mb-8">
      <h3
        id="scorecard-heading"
        className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-ink-caps"
      >
        Zone Performance Scorecard
      </h3>
      <DataTable
        ariaLabel="Zone Performance Scorecard"
        rowKey={(r) => r.zoneId}
        columns={columns}
        rows={rows}
        empty="No zones in scope."
      />
    </section>
  );
}
