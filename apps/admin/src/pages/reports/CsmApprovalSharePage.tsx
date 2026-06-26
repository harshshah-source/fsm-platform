import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiCsmApprovalShare, type CsmBackupZoneRow } from '../../api/roleBackup';
import {
  DataTable,
  EmptyState,
  MetricStrip,
  PageHeader,
  type Column,
  type Metric,
} from '../../components/data';
import { BarChartCard, ChartCard } from '../../components/charts';

/**
 * CSM Backup Share report (Issue 27, AC#5, Operations Head). Per-zone share of acted-as-backup
 * actions performed by a Central Service Manager this month, so Operations Head can spot zones where
 * ZM backup is becoming routine. Attribution via `audit_logs.acting_zone` (stamped on acted-as flows).
 *
 * FE-20 reskin: presentation only — MetricStrip + BarChartCard summarise the existing share data and
 * the per-zone breakdown moves onto the canonical DataTable. The Ops-Head gate is route-level; the API
 * (`apiCsmApprovalShare`) and the `csm-row-*` selector contract are unchanged.
 */
export function CsmApprovalSharePage() {
  const [rows, setRows] = useState<CsmBackupZoneRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    apiCsmApprovalShare()
      .then(setRows)
      .catch(() => setError('Failed to load the CSM backup report'));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const metrics: Metric[] = useMemo(() => {
    const totalCsm = rows.reduce((s, r) => s + r.csmActions, 0);
    const totalActed = rows.reduce((s, r) => s + r.totalActedActions, 0);
    const overallShare = totalActed === 0 ? 0 : Math.round((totalCsm / totalActed) * 100);
    return [
      { label: 'CSM-acted actions', value: totalCsm, tone: 'brand' },
      { label: 'Total acted actions', value: totalActed, tone: 'info' },
      { label: 'Overall CSM share', value: `${overallShare}%`, tone: 'warning' },
      { label: 'Zones tracked', value: rows.length, tone: 'neutral' },
    ];
  }, [rows]);

  const chartData = useMemo(
    () => rows.map((r) => ({ name: `Zone ${r.zoneId}`, value: r.sharePct })),
    [rows],
  );

  const columns: Column<CsmBackupZoneRow>[] = [
    { key: 'zone', header: 'Zone', render: (r) => `Zone ${r.zoneId}` },
    { key: 'csm', header: 'CSM-acted actions', align: 'right', render: (r) => r.csmActions },
    { key: 'total', header: 'Total acted actions', align: 'right', render: (r) => r.totalActedActions },
    {
      key: 'share',
      header: 'CSM share',
      align: 'right',
      render: (r) => <span className="font-medium text-ink-strong">{r.sharePct}%</span>,
    },
  ];

  return (
    <section>
      <PageHeader
        title="CSM Backup Share"
        subtitle="Share of acted-as-backup actions performed by a Central Service Manager this month, by zone. Rising shares flag zones where Zonal-Manager backup is becoming routine."
      />

      {error && (
        <div
          role="alert"
          className="mb-4 rounded-md border border-critical/30 bg-critical-bg px-3 py-2 text-sm text-critical"
        >
          {error}
        </div>
      )}

      <MetricStrip metrics={metrics} />

      <div className="mb-5">
        <ChartCard title="CSM share by zone (%)">
          {chartData.length === 0 ? (
            <EmptyState message="No acted-as-backup activity this month." />
          ) : (
            <BarChartCard data={chartData} />
          )}
        </ChartCard>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.zoneId}
        rowTestId={(r) => `csm-row-${r.zoneId}`}
        ariaLabel="CSM Backup Share"
        empty={<EmptyState message="No acted-as-backup activity this month." />}
      />
    </section>
  );
}
