import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiDispatchRuns, type DispatchRunListRow } from '../../api/dispatch-runs';
import { DataTable, EmptyState, PageHeader, type Column } from '../../components/data';
import { Badge } from '../../components/ui';
import { IconClock } from '../../components/ui/icons';
import { STATUS_TONE, formatDateTime, formatDuration, triggerActor } from './format';

/**
 * Batch-Assignment transparency — runs list (Issue 123). Every daily/manual dispatch run as a row;
 * click through to the run detail (config-in-effect + per-zone cards). A ZONAL_MANAGER's totals are
 * clamped to their own zone server-side. Read-only.
 */
export function DispatchRunsPage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<DispatchRunListRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setError(null);
    setRows(null);
    apiDispatchRuns()
      .then(setRows)
      .catch(() => setError('Failed to load dispatch runs'));
  };
  useEffect(load, []);

  const columns: Column<DispatchRunListRow>[] = [
    { key: 'startedAt', header: 'When', render: (r) => <span className="tabular-nums">{formatDateTime(r.startedAt)}</span> },
    {
      key: 'trigger',
      header: 'Trigger',
      render: (r) => (
        <div className="flex items-center gap-2">
          <Badge tone={r.trigger === 'MANUAL' ? 'brand' : 'neutral'}>{r.trigger === 'MANUAL' ? 'Manual' : 'Auto'}</Badge>
          <span className="text-ink-muted">{triggerActor(r)}</span>
        </div>
      ),
    },
    { key: 'status', header: 'Status', render: (r) => <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge> },
    { key: 'duration', header: 'Duration', align: 'right', render: (r) => formatDuration(r.durationMs) },
    { key: 'zones', header: 'Zones', align: 'right', render: (r) => r.zones },
    { key: 'batches', header: 'Batches', align: 'right', render: (r) => r.batches },
    { key: 'dispatched', header: 'Dispatched', align: 'right', render: (r) => r.ticketsDispatched },
    { key: 'recommended', header: 'Recommended', align: 'right', render: (r) => r.recommended },
    {
      key: 'unassignable',
      header: 'Unassignable',
      align: 'right',
      render: (r) => (r.unassignable > 0 ? <span className="font-semibold text-warning">{r.unassignable}</span> : r.unassignable),
    },
    {
      key: 'errors',
      header: 'Errors',
      align: 'right',
      render: (r) => (r.errorCount > 0 ? <span className="font-semibold text-critical">{r.errorCount}</span> : r.errorCount),
    },
  ];

  return (
    <section>
      <PageHeader
        title="Dispatch Runs"
        subtitle="Every batch-assignment run — the daily auto-dispatch and any manual triggers — with the configuration that applied and why each ticket landed where it did. Read-only; a Zonal Manager sees their own zone's slice."
      />

      <DataTable
        columns={columns}
        rows={rows ?? []}
        rowKey={(r) => r.runId}
        rowTestId={(r) => `dispatch-run-${r.runId}`}
        ariaLabel="Dispatch runs"
        loading={rows === null && error === null}
        error={error}
        onRetry={load}
        onRowClick={(r) => navigate(`/dispatch-runs/${r.runId}`)}
        empty={<EmptyState icon={<IconClock />} message="No dispatch runs yet — the daily batch hasn't run." />}
      />
    </section>
  );
}
