import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  apiIntradayUpdates,
  type IntradayUpdateRow,
  type IntradayUpdateType,
} from '../../api/intradayUpdates';
import { DataTable, MetricCard, PageHeader, type Column } from '../../components/data';
import { Badge } from '../../components/ui';
import type { BadgeTone } from '../../components/ui/Badge';

/**
 * Intra-day Queue (Issue 31 · FE-13 parity, `/intraday`, reference 13). Renders the ZM manual same-day
 * updates (MANUAL_ZM_UPDATE: ADD / REMOVE / REORDER) newest-first, with an update-type metric strip and a
 * table (Event / Ticket / SE / SE Acceptance / By / At). Manager roles only; these manual updates apply
 * immediately and need **no SE Acceptance** (AC#2) — the SE-Acceptance lifecycle belongs to the
 * system-triggered CRITICAL insertions (Issue 29), which land in this same view later.
 *
 * FE-13 is a presentation-only refactor onto `PageHeader` + `MetricCard` + `DataTable` with severity
 * row-accents; the `iq-metric-strip` / `iq-metric-*` / `iq-row-*` test ids, the `Intra-day Queue`
 * aria-label, the event labels, and the ticket-drawer navigation are preserved. The SE-Acceptance column
 * is a forward-compatible placeholder for the Issue 29/30 acceptance vocabulary (StatusPill tones for
 * PENDING_ACCEPTANCE / TIMED_OUT / DECLINED / ESCALATION_REQUIRED already exist in FE-04).
 */
const EVENT_LABEL: Record<IntradayUpdateType, string> = {
  ADD: 'ZM same-day update — Add',
  REMOVE: 'ZM same-day update — Remove',
  REORDER: 'ZM same-day update — Reorder',
};

const EVENT_TONE: Record<IntradayUpdateType, BadgeTone> = {
  ADD: 'success',
  REMOVE: 'critical',
  REORDER: 'info',
};

const EVENT_ACCENT: Record<IntradayUpdateType, string> = {
  ADD: 'border-l-success',
  REMOVE: 'border-l-critical',
  REORDER: 'border-l-info',
};

const METRIC_TONE: Record<IntradayUpdateType, 'success' | 'critical' | 'info'> = {
  ADD: 'success',
  REMOVE: 'critical',
  REORDER: 'info',
};

const TYPES: IntradayUpdateType[] = ['ADD', 'REMOVE', 'REORDER'];

function fmtTime(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ');
}

export function IntradayQueuePage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<IntradayUpdateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiIntradayUpdates()
      .then(setRows)
      .catch(() => setError('Failed to load the Intra-day Queue'))
      .finally(() => setLoading(false));
  }, []);

  const counts = TYPES.map((t) => ({ type: t, n: rows.filter((r) => r.updateType === t).length }));

  const columns: Column<IntradayUpdateRow>[] = [
    {
      key: 'event',
      header: 'Event',
      render: (row) => <Badge tone={EVENT_TONE[row.updateType]}>{EVENT_LABEL[row.updateType]}</Badge>,
    },
    {
      key: 'ticket',
      header: 'Ticket',
      render: (row) =>
        row.ticketId ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              navigate(`/tickets/${row.ticketId}`);
            }}
            className="font-mono text-xs text-brand-700 hover:underline"
          >
            {row.ticketId.slice(0, 8)}
          </button>
        ) : (
          <span className="text-xs text-ink-muted">—</span>
        ),
    },
    {
      key: 'se',
      header: 'SE',
      render: (row) => <span className="font-mono text-xs text-ink">{row.seId ? row.seId.slice(0, 8) : '—'}</span>,
    },
    {
      key: 'acceptance',
      header: 'SE Acceptance',
      render: () => <span className="text-xs text-ink-muted">No acceptance required</span>,
    },
    {
      key: 'by',
      header: 'By',
      render: (row) => <span className="font-mono text-xs text-ink">{row.actorId.slice(0, 8)}</span>,
    },
    {
      key: 'at',
      header: 'At',
      align: 'right',
      render: (row) => <span className="text-ink-muted">{fmtTime(row.createdAt)}</span>,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Intra-day Queue"
        subtitle="Zonal-Manager manual same-day changes to SE Day Plans — add, remove, or reorder. Each applies immediately; no SE Acceptance is required. System-triggered CRITICAL insertions appear here too."
      />

      {error && (
        <p role="alert" className="mb-4 text-sm text-critical">
          {error}
        </p>
      )}

      <div data-testid="iq-metric-strip" className="mb-5 grid grid-cols-3 gap-3">
        {counts.map((c) => (
          <div key={c.type} data-testid={`iq-metric-${c.type}`}>
            <MetricCard label={c.type} value={c.n} tone={METRIC_TONE[c.type]} />
          </div>
        ))}
      </div>

      <DataTable
        ariaLabel="Intra-day Queue"
        rowKey={(r) => r.auditId}
        rowTestId={(r) => `iq-row-${r.auditId}`}
        rowAccent={(r) => EVENT_ACCENT[r.updateType]}
        columns={columns}
        rows={rows}
        loading={loading}
        empty="No intra-day updates yet today."
      />
    </div>
  );
}
