import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { apiZoneEngineers, type ZoneEngineer } from '../../api/schedules';
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
import { DispatchTimelineNote } from '../../components/domain';
import { Badge, Button } from '../../components/ui';
import type { BadgeTone } from '../../components/ui/Badge';
import { IntradayManualAssignModal } from './IntradayManualAssignModal';

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
 *
 * **#281 (#280 R9) — this is not a fourth tense.** It is the record of changes to today's committed
 * plans, subordinate to Schedules, and the copy says so rather than letting the sidebar imply a peer
 * relationship. The SE column links to the day plan the change was made TO (#280 R8's per-record
 * mechanism): a same-day edit is only legible against the plan it edited. Names come from
 * `/schedules/engineers` best-effort — neither event stream carries one, and a uuid is not a name.
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

/** #288 — work an engineer became unavailable on. The ledger's `insertion_type` for that path. */
const SE_UNAVAILABLE = 'SE_UNAVAILABLE';

/**
 * What this escalation *is*. Status alone stopped being enough with #288: two causes now write
 * `ESCALATION_REQUIRED` — no capacity-eligible engineer (#268), and an engineer going unavailable on
 * work already committed to them — and they are resolved by different actions. Labelling both "no
 * capacity" would tell a manager the wrong thing about half the queue.
 */
function insertionLabel(row: IntradayInsertionRow): string {
  if (row.status === 'ESCALATION_REQUIRED' && row.insertionType === SE_UNAVAILABLE) {
    return 'Engineer unavailable — work needs a new engineer';
  }
  return INSERTION_LABEL[row.status] ?? row.status;
}

/**
 * The row is stranded work: still formally assigned, so the queue's Assign cannot resolve it.
 *
 * Truthiness rather than `!== null`, deliberately — a payload from before this field existed carries
 * `undefined`, and treating that as "somebody holds it" would take the Assign button away from every
 * capacity escalation in the queue.
 */
const isStranded = (row: IntradayInsertionRow): boolean =>
  row.status === 'ESCALATION_REQUIRED' && Boolean(row.assignedSeId);
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
  const [assignTarget, setAssignTarget] = useState<IntradayInsertionRow | null>(null);
  const [engineers, setEngineers] = useState<ZoneEngineer[]>([]);

  const load = () => {
    Promise.all([apiIntradayUpdates(), apiIntradayInsertions()])
      .then(([u, i]) => {
        setUpdates(u);
        setInsertions(i);
      })
      .catch(() => setError('Failed to load the Intra-day Queue'))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  // Best-effort: the queue is the primary content and reads correctly with ids alone, so a failure
  // here degrades the SE column to its short id rather than failing the page (the #277 pattern).
  useEffect(() => {
    let alive = true;
    apiZoneEngineers()
      .then((rows) => alive && setEngineers(Array.isArray(rows) ? rows : []))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const seLabel = (seId: string | null): string =>
    seId ? (engineers.find((e) => e.engineerId === seId)?.name ?? seId.slice(0, 8)) : '—';

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
          <Badge tone={INSERTION_TONE[row.status] ?? 'neutral'}>{insertionLabel(row)}</Badge>
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
      /*
       * #281 AC8 — a same-day change is only legible against the plan it changed, and
       * `/schedules/:seId` renders exactly that. An escalation names no SE (no capacity-eligible one
       * existed), so there is nothing to link and the cell stays inert rather than linking nowhere.
       */
      key: 'se',
      header: 'SE',
      render: (row) => {
        // #288 — an escalation that names no offered SE may still be *held* by one: work stranded when
        // an engineer went unavailable is still formally theirs, and who holds it is the whole reason
        // this row cannot be resolved with Assign.
        const seId = row.kind === 'update' ? row.seId : (row.offeredSeId ?? row.assignedSeId);
        if (!seId) return <span className="text-xs text-ink-muted">—</span>;
        // The stranded row's engineer comes named from the server (#288). The `engineers` lookup below
        // is zone-scoped and would fall back to a uuid stub for anyone outside it — a name the backend
        // already resolved should not be thrown away and re-derived worse.
        const name = row.kind === 'insertion' && !row.offeredSeId && row.assignedSeName ? row.assignedSeName : seLabel(seId);
        return (
          <Link
            to={`/schedules/${seId}`}
            onClick={(e) => e.stopPropagation()}
            title={
              row.kind === 'insertion' && isStranded(row)
                ? `${name} holds this work — open their day plan to reassign it`
                : `Today's day plan for ${name}`
            }
            className="text-xs text-link hover:underline"
          >
            {name}
          </Link>
        );
      },
      exportValue: (row) => seLabel(row.kind === 'update' ? row.seId : (row.offeredSeId ?? row.assignedSeId)),
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
    {
      key: 'action',
      header: '',
      exportable: false,
      render: (row) => {
        if (row.kind !== 'insertion' || row.status !== 'ESCALATION_REQUIRED') return null;
        // #288 — Assign goes through `assignTicket`, which refuses a ticket that is already formally
        // assigned. Stranded work is still assigned (escalate-only, #282 R4: nothing is reassigned
        // automatically), so this button would 409 on exactly the rows it looks most needed on. The
        // action that resolves them is a reassign on the holder's day plan — where, since #289, the
        // impact of the move is shown before it is committed.
        if (isStranded(row)) {
          return (
            <Link
              to={`/schedules/${row.assignedSeId}`}
              data-testid={`iq-reassign-ins-${row.insertionId}`}
              onClick={(e) => e.stopPropagation()}
              className="whitespace-nowrap text-xs text-link hover:underline"
            >
              Reassign on the day plan →
            </Link>
          );
        }
        return (
          <Button
            size="sm"
            data-testid={`iq-assign-ins-${row.insertionId}`}
            onClick={(e) => {
              e.stopPropagation();
              setAssignTarget(row);
            }}
          >
            Assign
          </Button>
        );
      },
    },
  ];

  return (
    <div>
      <PageHeader
        title="Intra-day Queue"
        subtitle="Zonal-Manager manual same-day changes to SE Day Plans — add, remove, or reorder — alongside system-triggered CRITICAL assignments and escalations. Manual updates apply immediately, no SE Acceptance required; a CRITICAL ticket is assigned directly or escalated to the Zonal Manager."
      />

      <DispatchTimelineNote position="intraday" />

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

      {assignTarget && (
        <IntradayManualAssignModal
          insertion={assignTarget}
          onClose={() => setAssignTarget(null)}
          onAssigned={() => {
            setAssignTarget(null);
            load();
          }}
        />
      )}
    </div>
  );
}
