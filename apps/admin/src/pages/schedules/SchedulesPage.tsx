import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiListSchedules, type ScheduleRow } from '../../api/schedules';
import { DataTable, MetricStrip, PageHeader, type Column, type Metric } from '../../components/data';
import { Badge } from '../../components/ui';
import type { BadgeTone } from '../../components/ui/Badge';

/**
 * ZM Batch-Schedule list (Issue 13b AC#1 · FE-12 parity, reference 12). One row per SE Work Schedule with
 * batch/ticket counts and an AUTO_ASSIGNED / OVERRIDDEN status badge. Monitoring only: system batches
 * auto-dispatch to the SE Day Plan, so there is **no Approve action and no approval countdown** (the gate
 * was removed — CONTEXT.md Decisions §7, ADR-0019 superseded). Zone scope is enforced server-side.
 *
 * FE-12 is a presentation-only refactor onto `PageHeader` + `MetricStrip` + the canonical `DataTable`;
 * the monitoring fetch, the `Batch Schedules` aria-label, the `schedule-status-*` test ids, the
 * row→`/schedules/:seId` navigation, and the absence of any Approve gate are all preserved.
 */
const STATUS_TONE: Record<string, BadgeTone> = {
  AUTO_ASSIGNED: 'neutral',
  OVERRIDDEN: 'warning',
};

export function SchedulesPage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<ScheduleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    apiListSchedules()
      .then((r) => alive && setRows(r))
      .catch(() => alive && setError('Failed to load schedules'))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  const metrics: Metric[] = useMemo(() => {
    const overridden = rows.filter((r) => r.status === 'OVERRIDDEN').length;
    const tickets = rows.reduce((s, r) => s + r.ticketCount, 0);
    const batches = rows.reduce((s, r) => s + r.batchCount, 0);
    return [
      { label: 'Schedules', value: rows.length, hint: 'SEs with a day plan', tone: 'info' },
      { label: 'Auto-Assigned', value: rows.length - overridden, hint: 'no gate', tone: 'success' },
      { label: 'Overridden', value: overridden, hint: 'ZM adjusted', tone: 'warning' },
      { label: 'Tickets', value: tickets, hint: `${batches} batches`, tone: 'brand' },
    ];
  }, [rows]);

  const columns: Column<ScheduleRow>[] = [
    {
      key: 'engineer',
      header: 'Engineer',
      render: (r) => <span className="font-medium text-brand-700">{r.seId}</span>,
    },
    {
      key: 'dates',
      header: 'Dates',
      render: (r) => (
        <span className="text-ink">{r.dateFrom === r.dateTo ? r.dateFrom : `${r.dateFrom} – ${r.dateTo}`}</span>
      ),
    },
    { key: 'batches', header: 'Batches', align: 'right', render: (r) => <span className="tabular-nums">{r.batchCount}</span> },
    { key: 'tickets', header: 'Tickets', align: 'right', render: (r) => <span className="tabular-nums">{r.ticketCount}</span> },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <span data-testid={`schedule-status-${r.status}`}>
          <Badge tone={STATUS_TONE[r.status] ?? 'neutral'}>{r.status}</Badge>
        </span>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Batch Schedule"
        subtitle="Auto-assigned SE day plans — monitoring only. Batches dispatch automatically; no approval gate."
      />
      {error && (
        <p role="alert" className="mb-4 text-sm text-critical">
          {error}
        </p>
      )}
      <MetricStrip metrics={metrics} />
      <DataTable
        ariaLabel="Batch Schedules"
        rowKey={(r) => r.scheduleId}
        columns={columns}
        rows={rows}
        loading={loading}
        onRowClick={(r) => navigate(`/schedules/${r.seId}`)}
        empty="No schedules in scope."
      />
    </div>
  );
}
