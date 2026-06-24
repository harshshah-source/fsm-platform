import { useMemo, useState } from 'react';
import type { ZoneOverviewRow } from '../../api/dashboard';
import { downloadCsv, toCsv } from '../../lib/csv';
import { BUCKET_CLASS, BUCKET_LABEL, SLA_BUCKETS } from '../../lib/slaBucket';

/**
 * Zone Overview table (Issue 06 AC#2/#5). One row per zone: total inactive + per-SLA-bucket counts
 * in severity order with the reference colour coding, plus a trend-vs-previous-day cell (a neutral
 * "—" placeholder until the daily-history table lands, Issue 40) and a CSV export.
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

  return (
    <section aria-labelledby="zone-overview-heading" className="mb-8">
      <div className="mb-2 flex items-center justify-between">
        <h3 id="zone-overview-heading" className="text-lg font-semibold">
          Zone Overview
        </h3>
        <div className="flex items-center gap-2 text-sm">
          <select
            aria-label="Filter by zone"
            value={zoneFilter}
            onChange={(e) => setZoneFilter(e.target.value)}
            className="rounded border px-2 py-1"
          >
            <option value="">All zones</option>
            {[...new Set(rows.map((r) => r.zoneName))].map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by bucket"
            value={bucketFilter}
            onChange={(e) => setBucketFilter(e.target.value)}
            className="rounded border px-2 py-1"
          >
            <option value="">All buckets</option>
            {SLA_BUCKETS.map((b) => (
              <option key={b} value={b}>
                {BUCKET_LABEL[b]}
              </option>
            ))}
          </select>
          <button type="button" onClick={exportCsv} className="rounded border px-2 py-1">
            Export Zone Overview
          </button>
        </div>
      </div>
      <table aria-label="Zone Overview" className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b text-left">
            <th className="py-1 pr-3">Zone</th>
            <th className="py-1 pr-3">Total</th>
            {SLA_BUCKETS.map((b) => (
              <th key={b} className="py-1 pr-2">
                {BUCKET_LABEL[b]}
              </th>
            ))}
            <th className="py-1 pr-2">Trend</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((r) => (
            <tr key={r.zoneId} className="border-b">
              <td className="py-1 pr-3 font-medium">{r.zoneName}</td>
              <td className="py-1 pr-3">{r.totalInactive}</td>
              {SLA_BUCKETS.map((b) => {
                const count = r.byBucket[b] ?? 0;
                return (
                  <td key={b} className="py-1 pr-2">
                    <span
                      data-testid={`bucket-${b}`}
                      className={`inline-block min-w-6 rounded px-1 text-center ${
                        count > 0 ? BUCKET_CLASS[b] : 'text-slate-300'
                      }`}
                    >
                      {count}
                    </span>
                  </td>
                );
              })}
              <td className="py-1 pr-2">
                <span data-testid="trend" className="text-slate-500">
                  {r.trendPctVsPrevDay === null ? '—' : `${r.trendPctVsPrevDay}%`}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
