import { useMemo, useState } from 'react';
import type { ZoneOverviewRow } from '../../api/dashboard';
import { DataTable, FilterBar, FilterSelect, type Column } from '../../components/data';
import { Button } from '../../components/ui';
import { cn } from '../../lib/cn';
import { downloadCsv, toCsv } from '../../lib/csv';
import { BUCKET_CLASS, BUCKET_LABEL, SLA_BUCKETS } from '../../lib/slaBucket';

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

  const exportCsv = () => {
    const headers = ['Zone', 'Total inactive', ...SLA_BUCKETS.map((b) => BUCKET_LABEL[b]), 'Trend %'];
    const body = visible.map((r) => [
      r.zoneName,
      r.totalInactive,
      ...SLA_BUCKETS.map((b) => r.byBucket[b] ?? 0),
      r.trendPctVsPrevDay ?? '',
    ]);
    downloadCsv('zone-overview.csv', toCsv(headers, body));
  };

  const columns: Column<ZoneOverviewRow>[] = [
    {
      key: 'zone',
      header: 'Zone',
      render: (r) => <span className="font-medium text-ink-strong">{r.zoneName}</span>,
    },
    {
      key: 'total',
      header: 'Total',
      align: 'right',
      render: (r) => <span className="tabular-nums">{r.totalInactive}</span>,
    },
    ...SLA_BUCKETS.map<Column<ZoneOverviewRow>>((b) => ({
      key: b,
      header: BUCKET_LABEL[b],
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
    <section aria-labelledby="zone-overview-heading" className="mb-8">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3
          id="zone-overview-heading"
          className="text-[11px] font-semibold uppercase tracking-wider text-ink-caps"
        >
          Zone Overview
        </h3>
        <FilterBar className="mb-0">
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
                {BUCKET_LABEL[b]}
              </option>
            ))}
          </FilterSelect>
          <Button variant="secondary" size="sm" onClick={exportCsv}>
            Export Zone Overview
          </Button>
        </FilterBar>
      </div>
      <DataTable
        ariaLabel="Zone Overview"
        rowKey={(r) => r.zoneId}
        columns={columns}
        rows={visible}
        empty="No inactive devices in scope."
      />
    </section>
  );
}
