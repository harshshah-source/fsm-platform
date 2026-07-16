import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiDispatchBatchDetail, type DispatchAssignmentRow, type DispatchBatchDetail } from '../../api/dispatch-runs';
import { DataTable, EmptyState, ErrorState, PageHeader, type Column } from '../../components/data';
import { Badge } from '../../components/ui';
import { TracePanel } from './DecisionTrace';

/**
 * Dispatch run — batch detail (Issue 123). The batch's assignment rows; each row expands inline to the
 * per-ticket decision trace ("why this SE", in precedence terms). While scores are degenerate (all
 * candidates score identically until travel-distance scoring lands) the numeric score is hidden and the
 * selection basis reads "Precedence". Read-only.
 */
export function DispatchBatchDetailPage() {
  const { runId = '', batchId = '' } = useParams();
  const [detail, setDetail] = useState<DispatchBatchDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setError(null);
    setDetail(null);
    apiDispatchBatchDetail(runId, batchId)
      .then(setDetail)
      .catch(() => setError('Failed to load this batch'));
  };
  useEffect(load, [runId, batchId]);

  const columns: Column<DispatchAssignmentRow>[] = [
    {
      key: 'device',
      header: 'Device / Vehicle',
      render: (r) => (
        <div>
          <div>{r.deviceId ?? <span className="font-mono text-xs">{r.ticketId.slice(0, 8)}</span>}</div>
          {r.vehicleNo && <div className="text-xs text-ink-muted">{r.vehicleNo}</div>}
        </div>
      ),
    },
    {
      key: 'company',
      header: 'Company',
      render: (r) => (
        <div>
          <div>{r.companyName ?? '—'}</div>
          {r.transporterName && <div className="text-xs text-ink-muted">{r.transporterName}</div>}
        </div>
      ),
    },
    { key: 'rank', header: 'Rank', align: 'right', render: (r) => (r.rank == null ? '—' : `#${r.rank}`) },
    {
      key: 'basis',
      header: 'Selection basis',
      render: (r) =>
        r.scoreDegenerate === false && r.score != null ? (
          <span className="tabular-nums">{r.score.toFixed(2)}</span>
        ) : (
          <Badge tone="neutral" title="Scores are identical until travel-distance scoring is enabled — precedence decided.">
            Precedence
          </Badge>
        ),
    },
    { key: 'rec', header: 'Recommendation', render: (r) => (r.recStatus ? <Badge tone="info">{r.recStatus}</Badge> : '—') },
    { key: 'ticket', header: 'Ticket', render: (r) => <Badge tone="neutral">{r.ticketStatus}</Badge> },
  ];

  return (
    <section>
      <Link
        to={detail ? `/dispatch-runs/${runId}/zones/${detail.zoneId}` : `/dispatch-runs/${runId}`}
        className="mb-3 inline-flex items-center gap-1 text-sm text-brand-600 hover:underline"
      >
        ← Back to zone
      </Link>

      <PageHeader
        title={detail ? `${detail.seName ?? 'Engineer'} · ${detail.plantName}` : 'Batch'}
        subtitle={
          detail
            ? `Batch #${detail.batchId} · ${detail.rows.length} ticket${detail.rows.length === 1 ? '' : 's'} · expand a row for the decision trace`
            : 'Loading batch…'
        }
      />

      {error && <ErrorState message={error} onRetry={load} />}

      {detail && (
        <DataTable
          columns={columns}
          rows={detail.rows}
          rowKey={(r) => r.ticketId}
          rowTestId={(r) => `dispatch-assignment-row-${r.ticketId}`}
          ariaLabel="Batch assignments"
          empty={<EmptyState message="No tickets on this batch." />}
          renderExpanded={(r) => (r.hasTrace ? <TracePanel runId={runId} ticketId={r.ticketId} /> : null)}
        />
      )}
    </section>
  );
}
