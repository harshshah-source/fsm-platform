import { useNavigate } from 'react-router-dom';
import type { ZoneOverviewRow } from '../../api/dashboard';
import { DataTable, type Column } from '../../components/data';
import { SLABadge } from '../../components/domain';
import { criticalOnlyCount, SLA_BUCKETS, type SlaBucket } from '../../lib/slaBucket';
import { formatInactiveOfTotal } from '../../lib/inactiveDuration';

/** Worst (most-severe non-zero) bucket in a zone — `SLA_BUCKETS` is in descending severity order. */
function worstBucket(byBucket: Record<string, number>): SlaBucket | null {
  return SLA_BUCKETS.find((b) => (byBucket[b] ?? 0) > 0) ?? null;
}

/**
 * Zone Performance Scorecard (FE-07, reference 03/04). A cross-zone league table derived from the
 * existing `zone-overview` aggregation — no new endpoint. Shared by the Central Tower (CSM) and
 * Pan-India Fleet Command (OH) variants.
 *
 * Issue 122: a ZONAL MANAGER column follows Zone; the "Critical" column counts strictly the CRITICAL
 * band (matching the KPI). Both the Critical count and the whole row are click-throughs to the device
 * list — the count deep-links to that zone's inactive CRITICAL devices, the row to the whole zone.
 */
export function ScorecardTable({ rows }: { rows: ZoneOverviewRow[] }) {
  const navigate = useNavigate();

  // Deep-link into the Device Detail list (`/reports/device`), pre-filtered from the clicked cell/row.
  const openZoneDevices = (zoneId: string, opts: { criticalOnly?: boolean } = {}) => {
    const params = new URLSearchParams({ zoneId, status: 'INACTIVE' });
    if (opts.criticalOnly) params.set('bucket', 'CRITICAL');
    navigate(`/reports/device?${params.toString()}`);
  };

  const columns: Column<ZoneOverviewRow>[] = [
    {
      key: 'zone',
      header: 'Zone',
      render: (r) => <span className="font-medium text-ink-strong">{r.zoneName}</span>,
      sortable: true,
      sortValue: (r) => r.zoneName,
    },
    {
      key: 'zm',
      header: 'Zonal Manager',
      render: (r) =>
        r.zonalManagerName ? (
          <span className="text-ink">{r.zonalManagerName}</span>
        ) : (
          <span className="text-ink-muted">—</span>
        ),
      sortable: true,
      sortValue: (r) => r.zonalManagerName ?? '',
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
      header: 'Critical',
      align: 'right',
      render: (r) => {
        const count = criticalOnlyCount(r.byBucket);
        return (
          <button
            type="button"
            data-testid="scorecard-critical"
            onClick={(e) => {
              e.stopPropagation();
              openZoneDevices(r.zoneId, { criticalOnly: true });
            }}
            disabled={count === 0}
            className="tabular-nums font-semibold text-critical underline-offset-2 hover:underline disabled:cursor-default disabled:text-ink-muted disabled:no-underline"
            title={count > 0 ? 'View CRITICAL devices in this zone' : undefined}
          >
            {count}
          </button>
        );
      },
      sortable: true,
      sortValue: (r) => criticalOnlyCount(r.byBucket),
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
        onRowClick={(r) => openZoneDevices(r.zoneId)}
        empty="No zones in scope."
      />
    </section>
  );
}
