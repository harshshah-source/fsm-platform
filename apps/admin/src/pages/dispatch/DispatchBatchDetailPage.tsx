import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiDispatchBatchDetail, type DispatchAssignmentRow, type DispatchBatchDetail } from '../../api/dispatch-runs';
import { DataTable, EmptyState, ErrorState, FilterSelect, PageHeader, SearchInput, type Column } from '../../components/data';
import { Badge } from '../../components/ui';
import { formatDateTimeWithYear } from '../../lib/datetime';
import { formatPlantDisplayName } from '../../lib/plantNames';
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
 *
 * **#281 — this is where `Run → Zone → Batch` stops being a dead end** (#280 R4/R10). The page named
 * an engineer, a plant and every ticket and linked none of them; its only two links pointed back UP.
 * The identity block below is the terminus the chain was missing: the SE's day plan is the primary
 * action (AC6), with the plant's device investigation and each row's ticket beside it (AC7). Every
 * destination already existed and is already gated to these same manager roles — nothing here widens
 * anyone's reach (AC12), and nothing here writes (AC5: a historical run stays read-only).
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
      // #281 AC7 — the row's identity IS its ticket, and `/tickets/:ticketId` is live. Linking the
      // cell the operator already reads for identity beats adding a twelfth column of arrows.
      key: 'device',
      header: 'Device',
      width: '9%',
      className: 'break-all',
      render: (r) => (
        <Link
          to={`/tickets/${r.ticketId}`}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Open ticket ${r.deviceId ?? r.ticketId}`}
          className="text-link hover:underline"
        >
          {r.deviceId ?? <span className="font-mono text-xs">{r.ticketId.slice(0, 8)}</span>}
        </Link>
      ),
      // The export must keep carrying the value, not a React element's incidental text.
      exportValue: (r) => r.deviceId ?? r.ticketId,
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

      {/*
        #281 AC6/AC7 — the batch's identity, and the three questions it opens onto.

        This block is also the page's only VISIBLE title: `PageHeader` renders screen-reader-only, so
        before this the batch named its engineer and plant nowhere a sighted operator could read them
        outside the repeated table columns.

        The day plan is deliberately the primary action and is placed first: "what did this SE actually
        end up doing today" is the question a dispatch record raises, and answering it used to cost a
        trip to the sidebar and a search by name. The other two are secondary because they leave the
        dispatch timeline entirely.
      */}
      {detail && (
        <div data-testid="batch-identity" className="mb-4 rounded-lg border border-line bg-surface p-3">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
            <div data-testid="batch-se-link" className="min-w-0">
              <div className="text-[11px] uppercase tracking-wide text-ink-muted">Service Engineer</div>
              <Link to={`/schedules/${detail.seId}`} className="text-base font-semibold text-link hover:underline">
                {detail.seName ?? 'This engineer'}
              </Link>
              <div className="text-xs text-ink-muted">See the day plan this batch produced →</div>
            </div>

            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-wide text-ink-muted">Plant</div>
              <Link
                to={`/reports/device?plantId=${encodeURIComponent(detail.plantId)}`}
                className="text-sm text-link hover:underline"
              >
                {formatPlantDisplayName(detail.plantName) || detail.plantName}
              </Link>
              <div className="text-xs text-ink-muted">See this plant&rsquo;s devices →</div>
            </div>

            <div className="ml-auto text-right">
              <div className="text-[11px] uppercase tracking-wide text-ink-muted">Batch</div>
              <div className="text-sm text-ink tabular-nums">#{detail.batchId}</div>
              <div className="text-xs text-ink-muted">
                {detail.rows.length} ticket{detail.rows.length === 1 ? '' : 's'}
              </div>
            </div>
          </div>

          {/* #280 R3/#281 AC5 — the ledger says what it is. A batch is a record of a decision already
              taken; the links move the operator to surfaces that can act, they do not act here. */}
          <p data-testid="batch-identity-note" className="mt-2 text-xs text-ink-muted">
            This is what this run did — a record, not a plan you can edit. Changes to today&rsquo;s work
            are made on the SE&rsquo;s day plan.
          </p>
        </div>
      )}

      {detail && (
        <>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(r) => r.ticketId}
            rowTestId={(r) => `dispatch-assignment-row-${r.ticketId}`}
            ariaLabel="Batch assignments"
            toolbar={
              <>
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
              </>
            }
            exportName={`Batch #${detail?.batchId ?? batchId}`}
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
