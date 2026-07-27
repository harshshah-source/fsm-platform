import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiDispatchBatchDetail, type DispatchAssignmentRow, type DispatchBatchDetail } from '../../api/dispatch-runs';
import { DataTable, EmptyState, ErrorState, ExportMenu, FilterBar, FilterSelect, PageHeader, SearchInput, type Column } from '../../components/data';
import { Badge } from '../../components/ui';
import { formatDateTimeWithYear } from '../../lib/datetime';
import { exportTable, type ExportFormat } from '../../lib/exportFile';
import { formatInactiveDuration } from '../../lib/inactiveDuration';
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

  // Widths drive the fixed table layout (`tableLayout="fixed"` below) so all 11 columns fit the card and
  // the operator never scrolls sideways; long ids/names wrap (`break-all` on the mono id columns).
  // Re-proportioned down from the pre-#160 98% total to leave room for the leading 3.5rem S.No. column.
  const columns: Column<DispatchAssignmentRow>[] = [
    {
      key: 'device',
      header: 'Device',
      width: '9%',
      className: 'break-all',
      render: (r) => r.deviceId ?? <span className="font-mono text-xs">{r.ticketId.slice(0, 8)}</span>,
    },
    {
      key: 'vehicle',
      header: 'Vehicle No.',
      width: '9%',
      className: 'break-all',
      render: (r) => (r.vehicleNo ? <span className="font-mono text-xs">{r.vehicleNo}</span> : <span className="text-ink-muted">—</span>),
    },
    // AutoPlant device context (Device Type / IMSI from the master mirror; Inactive Duration + Trip
    // Creation from the 30-min telemetry tick). Sparse at source, so "—" is a normal reading.
    {
      key: 'deviceType',
      header: 'Device Type',
      width: '7%',
      render: (r) => r.deviceType ?? <span className="text-ink-muted">—</span>,
    },
    {
      key: 'imsiNo',
      header: 'IMSI No',
      width: '9%',
      className: 'break-all',
      render: (r) => (r.imsiNo ? <span className="font-mono text-xs tabular-nums">{r.imsiNo}</span> : <span className="text-ink-muted">—</span>),
    },
    { key: 'company', header: 'Company', width: '10%', render: (r) => r.companyName ?? <span className="text-ink-muted">—</span> },
    // Plant + SE are batch-level (a batch is one SE dispatched to one plant), so every row shares the
    // batch's values. Plant sits directly after Company per the requested column order.
    { key: 'plant', header: 'Plant', width: '10%', render: () => detail?.plantName ?? <span className="text-ink-muted">—</span> },
    { key: 'se', header: 'SE', width: '9%', render: () => detail?.seName ?? <span className="text-ink-muted">—</span> },
    {
      key: 'transporter',
      header: 'Transporter',
      width: '9%',
      render: (r) => (r.transporterName ? r.transporterName : <span className="text-ink-muted">—</span>),
    },
    {
      key: 'inactiveDuration',
      header: 'Inactive Duration',
      align: 'right',
      width: '8%',
      // Same derivation as the device list — one shared helper, so the two surfaces can never disagree.
      render: (r) => {
        const d = formatInactiveDuration(r.latestGpsDatetime);
        return d ? <span className="tabular-nums">{d}</span> : <span className="text-ink-muted">—</span>;
      },
    },
    {
      key: 'tripCreation',
      header: 'Trip Creation Date Time',
      width: '9%',
      render: (r) => <span className="tabular-nums">{formatDateTimeWithYear(r.tripCreationDatetime)}</span>,
    },
    { key: 'ticket', header: 'Ticket', width: '6%', render: (r) => <Badge tone="neutral">{r.ticketStatus}</Badge> },
  ];

  // Download the current (searched/filtered) rows in the chosen format — columns match the table above.
  const exportBatch = (format: ExportFormat) => {
    const headers = [
      'Device', 'Vehicle No.', 'Device Type', 'IMSI No', 'Company', 'Plant', 'SE', 'Transporter',
      'Inactive Duration', 'Trip Creation Date Time', 'Ticket',
    ];
    const body = rows.map((r) => [
      r.deviceId ?? r.ticketId.slice(0, 8),
      r.vehicleNo ?? '',
      r.deviceType ?? '',
      r.imsiNo ?? '',
      r.companyName ?? '',
      detail?.plantName ?? '',
      detail?.seName ?? '',
      r.transporterName ?? '',
      formatInactiveDuration(r.latestGpsDatetime) ?? '',
      formatDateTimeWithYear(r.tripCreationDatetime),
      r.ticketStatus,
    ]);
    exportTable(format, `batch-${detail?.batchId ?? batchId}`, `Batch #${detail?.batchId ?? batchId}`, headers, body);
  };

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
            <ExportMenu onExport={exportBatch} disabled={rows.length === 0} label="Download" />
          </FilterBar>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(r) => r.ticketId}
            rowTestId={(r) => `dispatch-assignment-row-${r.ticketId}`}
            ariaLabel="Batch assignments"
            tableLayout="fixed"
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
