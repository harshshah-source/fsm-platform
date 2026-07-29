import { useMemo, useState } from 'react';
import type { ZoneOverviewRow } from '../../api/dashboard';
import { DataTable, FilterSelect, type Column } from '../../components/data';
import { InactiveCountLink } from '../../components/domain';
import { cn } from '../../lib/cn';
import { BUCKET_CLASS, BUCKET_LABEL, BUCKET_LABEL_RANGE, BUCKET_RANGE_LABEL, SLA_BUCKETS } from '../../lib/slaBucket';

/**
 * Zone Overview table (Issue 06 AC#2/#5 · FE-06). One row per zone: total inactive + per-SLA-bucket
 * counts in severity order with the reference colour coding, plus a trend-vs-previous-day cell (a
 * neutral "—" placeholder until the daily-history table lands, Issue 40) and a CSV export.
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
      key: 'total',
      header: 'Inactive / Total Device',
      align: 'right',
      render: (r) => (
        <span data-testid="zone-inactive-total" className="tabular-nums">
          <InactiveCountLink inactive={r.totalInactive} total={r.totalDevices} scope={{ zoneId: r.zoneId }} />
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
        empty="No inactive devices in scope."
      />
    </section>
  );
}
