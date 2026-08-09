import { useMemo, useState } from 'react';
import type { ZoneOverviewRow } from '../../api/dashboard';
import { ColumnHeader, DataTable, FilterSelect, type Column } from '../../components/data';
import { InactiveCountLink } from '../../components/domain';
import { cn } from '../../lib/cn';
import { formatCount, formatPct } from '../../lib/fleetFormat';
import { BUCKET_CLASS, BUCKET_LABEL, BUCKET_LABEL_RANGE, BUCKET_RANGE_LABEL, SLA_BUCKETS } from '../../lib/slaBucket';

/**
 * Zone Overview table (Issue 06 AC#2/#5 · FE-06). One row per zone: the operational breakdown
 * (Operational · Inactive Operational · Healthy · Warehouse · Inactive % · Fleet Health %) plus the
 * per-SLA-bucket counts in severity order with the reference colour coding, a trend-vs-previous-day
 * cell (a neutral "—" placeholder until the daily-history table lands, Issue 40) and a CSV export.
 *
 * Every rate divides by Operational, never by the mirrored total; warehouse devices are shown in their
 * own column and excluded from both sides of every ratio.
 *
 * Presentation-only refactor (FE-06): re-skinned onto the canonical `DataTable`; the `aria-label`,
 * the `bucket-<B>` / `trend` test ids, the filter labels, and the export button are all preserved.
 */
export function ZoneOverviewTable({ rows }: { rows: ZoneOverviewRow[] }) {
  const [zoneFilter, setZoneFilter] = useState('');
  const [bucketFilter, setBucketFilter] = useState('');

  const visible = useMemo(
    () =>
      rows.filter(
        (r) =>
          (zoneFilter === '' || r.zoneName === zoneFilter) &&
          (bucketFilter === '' || (r.byBucket[bucketFilter] ?? 0) > 0),
      ),
    [rows, zoneFilter, bucketFilter],
  );

  const columns: Column<ZoneOverviewRow>[] = [
    {
      key: 'zone',
      header: 'Zone',
      render: (r) => <span className="font-medium text-ink-strong">{r.zoneName}</span>,
    },
    {
      key: 'operational',
      header: <ColumnHeader label="Operational" kpi="operationalDevices" />,
      align: 'right',
      render: (r) => (
        <span data-testid="zone-operational" className="tabular-nums text-ink">
          {formatCount(r.operationalDevices)}
        </span>
      ),
    },
    {
      key: 'total',
      header: <ColumnHeader label="Inactive Operational" kpi="inactiveOperational" />,
      align: 'right',
      render: (r) => (
        <span data-testid="zone-inactive-total" className="tabular-nums">
          <InactiveCountLink
            inactive={r.inactiveOperational}
            operational={r.operationalDevices}
            scope={{ zoneId: r.zoneId }}
          />
        </span>
      ),
    },
    {
      key: 'healthy',
      header: <ColumnHeader label="Healthy" kpi="healthyOperational" />,
      align: 'right',
      render: (r) => (
        <span data-testid="zone-healthy" className="tabular-nums text-ink">
          {formatCount(r.healthyOperational)}
        </span>
      ),
    },
    {
      // #223 — the third state, beside Healthy and Inactive so the column totals visibly add up to
      // Operational. Without it the row reads as if two numbers should sum to a third, and does not.
      key: 'neverReported',
      header: <ColumnHeader label="Never Reported" kpi="neverReported" />,
      align: 'right',
      render: (r) => (
        <span data-testid="zone-never-reported" className="tabular-nums text-ink">
          {formatCount(r.neverReported)}
        </span>
      ),
    },
    {
      key: 'warehouse',
      header: <ColumnHeader label="Warehouse" kpi="warehouseDevices" />,
      align: 'right',
      render: (r) => (
        <span data-testid="zone-warehouse" className="tabular-nums text-ink-muted">
          {formatCount(r.warehouseDevices)}
        </span>
      ),
    },
    {
      key: 'inactivePct',
      header: <ColumnHeader label="Inactive %" kpi="inactivePct" />,
      align: 'right',
      render: (r) => (
        <span data-testid="zone-inactive-pct" className="tabular-nums font-semibold text-ink">
          {formatPct(r.inactivePct)}
        </span>
      ),
    },
    {
      key: 'fleetHealthPct',
      header: <ColumnHeader label="Fleet Health %" kpi="fleetHealthPct" />,
      align: 'right',
      render: (r) => (
        <span data-testid="zone-health-pct" className="tabular-nums font-semibold text-ink">
          {formatPct(r.fleetHealthPct)}
        </span>
      ),
    },
    ...SLA_BUCKETS.map<Column<ZoneOverviewRow>>((b) => ({
      key: b,
      // Column #2 — the bucket header carries its real inactivity range beneath the label (shared mapping).
      header: (
        <span className="flex flex-col items-end leading-tight">
          <span>{BUCKET_LABEL[b]}</span>
          <span className="text-[10px] font-normal normal-case tracking-normal text-ink-muted tabular-nums">
            {BUCKET_RANGE_LABEL[b]}
          </span>
        </span>
      ),
      align: 'right',
      render: (r) => {
        const count = r.byBucket[b] ?? 0;
        return (
          <span
            data-testid={`bucket-${b}`}
            className={cn(
              'inline-block min-w-7 rounded-full px-1.5 text-center text-xs font-semibold tabular-nums',
              count > 0 ? BUCKET_CLASS[b] : 'text-ink-muted/40',
            )}
          >
            {count}
          </span>
        );
      },
    })),
    {
      key: 'trend',
      header: 'Trend',
      align: 'right',
      render: (r) => (
        <span data-testid="trend" className="text-ink-muted">
          {r.trendPctVsPrevDay === null ? '—' : `${r.trendPctVsPrevDay}%`}
        </span>
      ),
    },
  ];

  return (
    // Heading is sr-only and the visible label moved into the table card's toolbar — the section
    // label, its filters and the rows are now one block instead of three stacked ones.
    <section aria-labelledby="zone-overview-heading" className="mb-6">
      <h3 id="zone-overview-heading" className="sr-only">
        Zone Overview
      </h3>
      <DataTable
        ariaLabel="Zone Overview"
        rowKey={(r) => r.zoneId}
        columns={columns}
        rows={visible}
        toolbarTitle="Zone Overview"
        toolbar={
          <>
            <FilterSelect
              aria-label="Filter by zone"
              value={zoneFilter}
              onChange={(e) => setZoneFilter(e.target.value)}
            >
              <option value="">All zones</option>
              {[...new Set(rows.map((r) => r.zoneName))].map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect
              aria-label="Filter by bucket"
              value={bucketFilter}
              onChange={(e) => setBucketFilter(e.target.value)}
            >
              <option value="">All buckets</option>
              {SLA_BUCKETS.map((b) => (
                <option key={b} value={b}>
                  {BUCKET_LABEL_RANGE[b]}
                </option>
              ))}
            </FilterSelect>
          </>
        }
        // Rows are now driven by the operational population, not by the inactive one — a zone with a
        // fleet but no inactive devices renders `0 / N` rather than vanishing.
        empty="No zones in scope."
      />
    </section>
  );
}
