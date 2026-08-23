import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  apiIntradayUpdates,
  type IntradayUpdateRow,
  type IntradayUpdateType,
} from '../../api/intradayUpdates';
import {
  apiIntradayInsertions,
  type IntradayInsertionRow,
  type IntradayInsertionStatus,
} from '../../api/intradayInsertions';
import { DataTable, MetricCard, PageHeader, type Column } from '../../components/data';
import { Badge } from '../../components/ui';
import type { BadgeTone } from '../../components/ui/Badge';

/**
 * Intra-day Queue (Issue 31 · FE-13 parity, `/intraday`, reference 13; #268 binds the second data
 * source). Two independent event streams, merged into one table newest-first:
 *
 *  - **ZM manual same-day updates** (MANUAL_ZM_UPDATE: ADD / REMOVE / REORDER) — apply immediately,
 *    need **no SE Acceptance** (AC#2).
 *  - **System-triggered CRITICAL insertions** (`intraday_insertions`, Issues 29/30, retired to direct
 *    assignment by #268): `ASSIGNED_DIRECT` (the sweep assigned the ticket directly, no offer/accept
 *    step ever existed) and `ESCALATION_REQUIRED` (no capacity-eligible SE — a ZM alert also fired).
 *
 * The second stream existed in the backend since Issue 29/30 and was never bound here — FE-13's own
 * docstring said it would "land in this same view later," and #197's audit later flagged that it
 * never had (zero `intraday-insertions` references in `apps/admin`). #268 is what actually wires it:
 * Q-B's "operationally visible" escalation criterion needs this table to show the row, not just fire
 * the alert.
 *
 * Presentation preserved from FE-13: `iq-metric-strip` / `iq-metric-*` / `iq-row-*` test ids, the
 * `Intra-day Queue` aria-label, the ticket-drawer navigation. `iq-row-*` insertion rows are keyed
 * `iq-row-ins-<insertionId>` — a separate id space from the ZM-update rows' `auditId`, which the two
 * sequences could otherwise collide with.
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

/** Only the two statuses #268 can ever write reach this table — the retired offer statuses are history. */
const INSERTION_LABEL: Partial<Record<IntradayInsertionStatus, string>> = {
  ASSIGNED_DIRECT: 'System CRITICAL assignment',
  ESCALATION_REQUIRED: 'System escalation — no capacity',
};
const INSERTION_TONE: Partial<Record<IntradayInsertionStatus, BadgeTone>> = {
  ASSIGNED_DIRECT: 'success',
  ESCALATION_REQUIRED: 'critical',
};
const INSERTION_ACCENT: Partial<Record<IntradayInsertionStatus, string>> = {
  ASSIGNED_DIRECT: 'border-l-success',
  ESCALATION_REQUIRED: 'border-l-critical',
};

type UnifiedRow =
  | ({ kind: 'update' } & IntradayUpdateRow)
  | ({ kind: 'insertion' } & IntradayInsertionRow);

const rowKey = (r: UnifiedRow) => (r.kind === 'update' ? `upd-${r.auditId}` : `ins-${r.insertionId}`);
const rowTestId = (r: UnifiedRow) => (r.kind === 'update' ? `iq-row-${r.auditId}` : `iq-row-ins-${r.insertionId}`);
const rowAccent = (r: UnifiedRow) =>
  r.kind === 'update' ? EVENT_ACCENT[r.updateType] : INSERTION_ACCENT[r.status];
const rowAt = (r: UnifiedRow) => (r.kind === 'update' ? r.createdAt : r.createdAt);

function fmtTime(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ');
}

const shortId = (id: string | null): string => (id ? id.slice(0, 8) : '—');

export function IntradayQueuePage() {
  const navigate = useNavigate();
  const [updates, setUpdates] = useState<IntradayUpdateRow[]>([]);
  const [insertions, setInsertions] = useState<IntradayInsertionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([apiIntradayUpdates(), apiIntradayInsertions()])
      .then(([u, i]) => {
        setUpdates(u);
        setInsertions(i);
      })
      .catch(() => setError('Failed to load the Intra-day Queue'))
      .finally(() => setLoading(false));
  }, []);

  const rows: UnifiedRow[] = [
    ...updates.map((r): UnifiedRow => ({ kind: 'update', ...r })),
    ...insertions.map((r): UnifiedRow => ({ kind: 'insertion', ...r })),
  ].sort((a, b) => rowAt(b).localeCompare(rowAt(a)));

  const counts = TYPES.map((t) => ({ type: t, n: updates.filter((r) => r.updateType === t).length }));

  const columns: Column<UnifiedRow>[] = [
    {
      key: 'event',
      header: 'Event',
      render: (row) =>
        row.kind === 'update' ? (
          <Badge tone={EVENT_TONE[row.updateType]}>{EVENT_LABEL[row.updateType]}</Badge>
        ) : (
          <Badge tone={INSERTION_TONE[row.status] ?? 'neutral'}>
            {INSERTION_LABEL[row.status] ?? row.status}
          </Badge>
        ),
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
            className="font-mono text-xs text-link hover:underline"
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
      render: (row) => (
        <span className="font-mono text-xs text-ink">
          {row.kind === 'update' ? shortId(row.seId) : shortId(row.offeredSeId)}
        </span>
      ),
    },
    {
      key: 'acceptance',
      header: 'SE Acceptance',
      render: (row) =>
        row.kind === 'update' ? (
          <span className="text-xs text-ink-muted">No acceptance required</span>
        ) : (
          <span className="text-xs text-ink-muted">{row.status}</span>
        ),
    },
    {
      key: 'by',
      header: 'By',
      render: (row) => (
        <span className="font-mono text-xs text-ink">{row.kind === 'update' ? row.actorId.slice(0, 8) : 'SYSTEM'}</span>
      ),
    },
    {
      key: 'at',
      header: 'At',
      align: 'right',
      render: (row) => <span className="text-ink-muted">{fmtTime(rowAt(row))}</span>,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Intra-day Queue"
        subtitle="Zonal-Manager manual same-day changes to SE Day Plans — add, remove, or reorder — alongside system-triggered CRITICAL assignments and escalations. Manual updates apply immediately, no SE Acceptance required; a CRITICAL ticket is assigned directly or escalated to the Zonal Manager."
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
        rowKey={rowKey}
        rowTestId={rowTestId}
        rowAccent={rowAccent}
        columns={columns}
        rows={rows}
        loading={loading}
        empty="No intra-day updates yet today."
      />
    </div>
  );
}
