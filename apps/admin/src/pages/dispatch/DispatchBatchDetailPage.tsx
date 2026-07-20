import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiDispatchBatchDetail, type DispatchAssignmentRow, type DispatchBatchDetail } from '../../api/dispatch-runs';
import { DataTable, EmptyState, ErrorState, FilterBar, FilterSelect, PageHeader, SearchInput, type Column } from '../../components/data';
import { Badge } from '../../components/ui';
import { TracePanel } from './DecisionTrace';

/**
 * Batch detail (Issue 123) — reached as `/batches/:batchId`. The batch's assignment rows; each row
 * expands inline to the per-ticket decision trace ("why this SE", in precedence terms). While scores
 * are degenerate (all candidates score identically until travel-distance scoring lands) the numeric
 * score is hidden and the selection basis reads "Precedence". Read-only.
 *
 * Addressed by batch id alone: most live batches have no `run_id` (pre-ledger / ZM_MANUAL schedules),
 * and a run-scoped route left them unreachable from every drill-down. The run comes back on the
 * response — when it is null the batch still renders, minus the run-keyed trace and zone breadcrumb.
 */
export function DispatchBatchDetailPage() {
  const { batchId = '' } = useParams();
  const [detail, setDetail] = useState<DispatchBatchDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [transporter, setTransporter] = useState('');

  const load = () => {
    setError(null);
    setDetail(null);
    apiDispatchBatchDetail(batchId)
      .then(setDetail)
      .catch(() => setError('Failed to load this batch'));
  };
  useEffect(load, [batchId]);

  // Only the transporters actually on this batch are offered — no empty selections.
  const transporters = useMemo(
    () => [...new Set((detail?.rows ?? []).map((r) => r.transporterName).filter((t): t is string => Boolean(t)))].sort(),
    [detail],
  );

  const term = search.trim().toLowerCase();
  const rows = useMemo(() => {
    const source = detail?.rows ?? [];
    return source.filter((r) => {
      if (transporter && r.transporterName !== transporter) return false;
      if (!term) return true;
      // Search by device id or vehicle number (the two identities on a batch row).
      return r.deviceId?.toLowerCase().includes(term) || r.vehicleNo?.toLowerCase().includes(term);
    });
  }, [detail, term, transporter]);

  const columns: Column<DispatchAssignmentRow>[] = [
    {
      key: 'device',
      header: 'Device',
      render: (r) => r.deviceId ?? <span className="font-mono text-xs">{r.ticketId.slice(0, 8)}</span>,
    },
    {
      key: 'vehicle',
      header: 'Vehicle No.',
      render: (r) => (r.vehicleNo ? <span className="font-mono text-xs">{r.vehicleNo}</span> : <span className="text-ink-muted">—</span>),
    },
    { key: 'company', header: 'Company', render: (r) => r.companyName ?? <span className="text-ink-muted">—</span> },
    {
      key: 'transporter',
      header: 'Transporter',
      render: (r) => (r.transporterName ? r.transporterName : <span className="text-ink-muted">—</span>),
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
      {/* The zone drill-down is a view OF a run, so it only exists when this batch has one. A run-less
          batch (pre-ledger / ZM_MANUAL) has no zone page to go back to — offer the runs list instead. */}
      {detail?.runId ? (
        <Link
          to={`/dispatch-runs/${detail.runId}/zones/${detail.zoneId}`}
          className="mb-3 inline-flex items-center gap-1 text-sm text-brand-600 hover:underline"
        >
          ← Back to zone
        </Link>
      ) : (
        <Link to="/dispatch-runs" className="mb-3 inline-flex items-center gap-1 text-sm text-brand-600 hover:underline">
          ← Dispatch runs
        </Link>
      )}

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
        <>
          <FilterBar>
            <SearchInput
              aria-label="Search by device id or vehicle number"
              placeholder="Device ID or vehicle no…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-64"
            />
            <FilterSelect aria-label="Filter by transporter" value={transporter} onChange={(e) => setTransporter(e.target.value)}>
              <option value="">All transporters</option>
              {transporters.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </FilterSelect>
          </FilterBar>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(r) => r.ticketId}
            rowTestId={(r) => `dispatch-assignment-row-${r.ticketId}`}
            ariaLabel="Batch assignments"
            empty={<EmptyState message="No tickets match this search." />}
            // The trace is keyed by run, so it exists only for run-backed batches — `hasTrace` is
            // already false without one, and the null check keeps the contract explicit.
            renderExpanded={(r) =>
              r.hasTrace && detail.runId ? <TracePanel runId={detail.runId} ticketId={r.ticketId} /> : null
            }
          />
        </>
      )}
    </section>
  );
}
