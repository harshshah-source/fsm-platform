import { useCallback, useEffect, useRef, useState } from 'react';
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
import { DataTable, FilterSelect, MetricCard, PageHeader, type Column } from '../../components/data';
import { DispatchTimelineNote } from '../../components/domain';
import { Badge, Button } from '../../components/ui';
import type { BadgeTone } from '../../components/ui/Badge';
import { cn } from '../../lib/cn';
import { IntradayManualAssignModal } from './IntradayManualAssignModal';

/**
 * Intra-day Queue (Issue 31 · FE-13 parity, `/intraday`, reference 13; #268 binds the second data
 * source). Two independent event streams, merged into one table newest-first:
 *
 *  - **ZM manual same-day updates** (MANUAL_ZM_UPDATE: ADD / REMOVE / REORDER) — historical since #356
 *    retired the three write routes that produced them (#313 made `/batches/:id/override` the single
 *    same-day write surface), but still the record of what managers did to today's plans.
 *  - **System-triggered CRITICAL insertions** (`intraday_insertions`, Issues 29/30, retired to direct
 *    assignment by #268): `ASSIGNED_DIRECT` (the sweep assigned the ticket directly), `ACCEPTED` (a
 *    manager resolved an escalation by hand) and `ESCALATION_REQUIRED` (no capacity-eligible SE, or
 *    #288's engineer-went-unavailable).
 *
 * **#356 — this is the screen a dispatcher watches all day, and it was lying to them in three ways.**
 * The reads were unbounded, so the page got slower in exact proportion to how busy the day had been.
 * It loaded once, so what was on screen was whatever had been true when the tab was opened — and a
 * dispatcher assigning off a stale row is the failure this page exists to prevent. And a manager's own
 * assignment rendered its raw `ACCEPTED` enum, so a human decision and a system one read as the same
 * kind of event. What is added here is a bound with a pager, a refresh (both automatic and by hand),
 * and a label for every status. Nothing about the reference layout changes: the filter band the
 * reference already draws above the table (search · type · result count) is where the chips, the date
 * filter, the pager and Refresh go, riding `DataTable`'s own `toolbar` slot.
 *
 * Presentation preserved from FE-13: `iq-metric-strip` / `iq-metric-*` / `iq-row-*` test ids, the
 * `Intra-day Queue` aria-label, the ticket-drawer navigation. `iq-row-*` insertion rows are keyed
 * `iq-row-ins-<insertionId>` — a separate id space from the ZM-update rows' `auditId`.
 *
 * **#281 (#280 R9) — this is not a fourth tense.** It is the record of changes to today's committed
 * plans, subordinate to Schedules. The SE column links to the day plan the change was made TO (#280
 * R8): a same-day edit is only legible against the plan it edited. Names come from
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

/**
 * #356 AC3 — every status this table can receive has a label. **Every** one, not only the two the
 * current engine writes: `ACCEPTED` is written by `manualAssign` today, and the retired offer
 * machinery's three (`PENDING_ACCEPTANCE` / `DECLINED` / `TIMED_OUT`) are still on historical rows that
 * a `since` filter set wide enough will fetch. The previous `Partial<Record<…>>` fell through to
 * `row.status` for all four, which is how a manager's own decision came to be rendered as the word
 * ACCEPTED — a raw enum on the one screen whose job is saying what happened in words a human uses.
 */
const INSERTION_LABEL: Record<IntradayInsertionStatus, string> = {
  ASSIGNED_DIRECT: 'System CRITICAL assignment',
  ESCALATION_REQUIRED: 'System escalation — no capacity',
  ACCEPTED: 'Manager assignment',
  PENDING_ACCEPTANCE: 'Offer pending (retired flow)',
  DECLINED: 'Offer declined (retired flow)',
  TIMED_OUT: 'Offer timed out (retired flow)',
};

/** What the row's status means for the *acceptance* column, in words rather than the enum. */
const ACCEPTANCE_NOTE: Record<IntradayInsertionStatus, string> = {
  ASSIGNED_DIRECT: 'No acceptance required',
  ESCALATION_REQUIRED: 'Awaiting a manager',
  ACCEPTED: 'Assigned by a manager',
  PENDING_ACCEPTANCE: 'Awaited the engineer (retired flow)',
  DECLINED: 'Declined by the engineer (retired flow)',
  TIMED_OUT: 'No response from the engineer (retired flow)',
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
  return INSERTION_LABEL[row.status] ?? 'Intra-day change';
}

function acceptanceNote(row: IntradayInsertionRow): string {
  if (row.status === 'ESCALATION_REQUIRED' && row.insertionType === SE_UNAVAILABLE) {
    return 'Awaiting reassignment';
  }
  return ACCEPTANCE_NOTE[row.status] ?? 'No acceptance required';
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
  ACCEPTED: 'info',
  ESCALATION_REQUIRED: 'critical',
};
const INSERTION_ACCENT: Partial<Record<IntradayInsertionStatus, string>> = {
  ASSIGNED_DIRECT: 'border-l-success',
  ACCEPTED: 'border-l-info',
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

/** #356 — the page size the server also defaults to. Named here so the pager and the ask agree. */
const PAGE_SIZE = 50;

/** #356 AC2 — how often a visible tab re-reads. */
const REFRESH_MS = 30_000;

/**
 * The status chips, in the order a dispatcher triages: what needs me, then what the system did, then
 * what a human did. `null` is the unfiltered view.
 */
const STATUS_CHIPS: { key: string; label: string; status: IntradayInsertionStatus | null }[] = [
  { key: 'ALL', label: 'All events', status: null },
  { key: 'ESCALATION_REQUIRED', label: 'Needs a manager', status: 'ESCALATION_REQUIRED' },
  { key: 'ASSIGNED_DIRECT', label: 'System assigned', status: 'ASSIGNED_DIRECT' },
  { key: 'ACCEPTED', label: 'Manager assigned', status: 'ACCEPTED' },
];

/** The "since" windows, as hours back from now. `null` is everything the bound will reach. */
const SINCE_WINDOWS: { value: string; label: string; hours: number | null }[] = [
  { value: '0', label: 'All dates', hours: null },
  { value: '1', label: 'Last 24 hours', hours: 24 },
  { value: '2', label: 'Last 3 days', hours: 72 },
  { value: '3', label: 'Last 7 days', hours: 168 },
];

const shortId = (id: string | null): string => (id ? id.slice(0, 8) : '—');

/** One position in the merged walk: a cursor per stream, since the two streams page independently. */
interface Cursors {
  updates: string | null;
  insertions: string | null;
}

const START: Cursors = { updates: null, insertions: null };

export function IntradayQueuePage() {
  const navigate = useNavigate();
  const [updates, setUpdates] = useState<IntradayUpdateRow[]>([]);
  const [insertions, setInsertions] = useState<IntradayInsertionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [assignTarget, setAssignTarget] = useState<IntradayInsertionRow | null>(null);
  const [engineers, setEngineers] = useState<ZoneEngineer[]>([]);

  const [statusKey, setStatusKey] = useState<string>('ALL');
  const [sinceKey, setSinceKey] = useState<string>('0');
  /**
   * The trail back. Cursor paging can only go forward, so "Prev" is a stack of the positions already
   * visited rather than a subtraction — the same shape every keyset pager ends up with, and the reason
   * the pager offers Prev/Next rather than page numbers it cannot honestly compute.
   */
  const [trail, setTrail] = useState<Cursors[]>([START]);
  const [next, setNext] = useState<Cursors | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  const status = STATUS_CHIPS.find((c) => c.key === statusKey)?.status ?? null;
  const sinceHours = SINCE_WINDOWS.find((w) => w.value === sinceKey)?.hours ?? null;
  const here = trail[trail.length - 1];

  /**
   * One read of both streams at the current position.
   *
   * `background` distinguishes the 30 s tick from a click: an automatic refresh must never blank the
   * table into its loading skeleton under a dispatcher's cursor, and must never replace the rows on
   * screen with an error banner because one poll happened during a redeploy. A hand-driven load says
   * both things out loud; a background one keeps the last good page and tries again in 30 seconds.
   */
  const load = useCallback(
    async (at: Cursors, background = false) => {
      if (!background) setLoading(true);
      const since = sinceHours == null ? undefined : new Date(Date.now() - sinceHours * 3_600_000).toISOString();
      try {
        // A status filter is a question about insertions; a MANUAL_ZM_UPDATE audit row has an update
        // type and no status. Asking the update stream to honour it would be inventing a mapping, and
        // showing its rows through a filter that never touched them would be worse — so a narrowed
        // queue is insertions only, and says so by simply not listing them.
        const [u, i] = await Promise.all([
          status === null
            ? apiIntradayUpdates({ take: PAGE_SIZE, since, cursor: at.updates ?? undefined })
            : Promise.resolve({ rows: [] as IntradayUpdateRow[], nextCursor: null, limit: PAGE_SIZE }),
          apiIntradayInsertions({
            take: PAGE_SIZE,
            since,
            status: status === null ? undefined : [status],
            cursor: at.insertions ?? undefined,
          }),
        ]);
        setUpdates(u.rows);
        setInsertions(i.rows);
        setNext(
          u.nextCursor === null && i.nextCursor === null
            ? null
            : { updates: u.nextCursor ?? at.updates, insertions: i.nextCursor ?? at.insertions },
        );
        setError(null);
        setLastRefreshed(new Date());
      } catch {
        if (!background) setError('Failed to load the Intra-day Queue');
      } finally {
        if (!background) setLoading(false);
      }
    },
    [status, sinceHours],
  );

  // A filter change is a new walk: the cursor from the old filter names a row the new query may not
  // even contain, so the trail is reset rather than carried across.
  useEffect(() => {
    setTrail([START]);
  }, [statusKey, sinceKey]);

  useEffect(() => {
    void load(here);
    // `here` is compared by identity, which is what we want: a new position object means a real move.
  }, [load, here]);

  /**
   * #356 AC2 — the queue keeps up with the day on its own.
   *
   * Gated on `document.visibilityState` so a background tab is not polled: a dispatcher who leaves the
   * queue open overnight should come back to one read, not to twelve hundred. The tick re-reads the
   * *current* position rather than jumping home — a manager reading page 3 does not want the page to
   * walk out from under them every half minute.
   */
  const positionRef = useRef(here);
  positionRef.current = here;
  useEffect(() => {
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void load(positionRef.current, true);
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

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
      // #356 AC3 — words, not the enum. This cell used to print `row.status` verbatim, which is how
      // ASSIGNED_DIRECT and ESCALATION_REQUIRED reached the screen in capitals and underscores.
      render: (row) => (
        <span className="text-xs text-ink-muted">
          {row.kind === 'update' ? 'No acceptance required' : acceptanceNote(row)}
        </span>
      ),
      exportValue: (row) => (row.kind === 'update' ? 'No acceptance required' : acceptanceNote(row)),
    },
    {
      key: 'by',
      header: 'By',
      render: (row) => (
        <span className="font-mono text-xs text-ink">{row.kind === 'update' ? shortId(row.actorId) : 'SYSTEM'}</span>
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

  const pageIndex = trail.length;

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
        empty="No intra-day updates in this window."
        snoOffset={(pageIndex - 1) * PAGE_SIZE}
        toolbarTitle={
          <span className="text-xs font-normal normal-case tracking-normal text-ink-muted">
            {rows.length} on this page{pageIndex > 1 ? ` · page ${pageIndex}` : ''}
            {lastRefreshed ? ` · updated ${lastRefreshed.toISOString().slice(11, 16)}` : ''}
          </span>
        }
        toolbar={
          <>
            <div className="flex flex-wrap items-center gap-1 rounded-full border border-line bg-surface-card p-1 text-[11px] shadow-sm">
              {STATUS_CHIPS.map((chip) => (
                <button
                  key={chip.key}
                  type="button"
                  data-testid={`iq-status-${chip.key}`}
                  aria-pressed={statusKey === chip.key}
                  onClick={() => setStatusKey(chip.key)}
                  className={cn(
                    'rounded-full px-2.5 py-1 font-semibold transition-colors focus-ring',
                    statusKey === chip.key
                      ? 'bg-brand-600 text-white'
                      : 'text-ink-muted hover:bg-surface-sunken hover:text-ink-strong',
                  )}
                >
                  {chip.label}
                </button>
              ))}
            </div>

            <FilterSelect
              data-testid="iq-since"
              aria-label="Date range"
              value={sinceKey}
              onChange={(e) => setSinceKey(e.target.value)}
            >
              {SINCE_WINDOWS.map((w) => (
                <option key={w.value} value={w.value}>
                  {w.label}
                </option>
              ))}
            </FilterSelect>

            <Button
              variant="ghost"
              size="sm"
              data-testid="iq-prev"
              disabled={trail.length <= 1}
              onClick={() => setTrail((t) => (t.length > 1 ? t.slice(0, -1) : t))}
            >
              Prev
            </Button>
            <Button
              variant="ghost"
              size="sm"
              data-testid="iq-next"
              disabled={next === null}
              onClick={() => next && setTrail((t) => [...t, next])}
            >
              Next
            </Button>
            <Button
              variant="ghost"
              size="sm"
              data-testid="iq-refresh"
              onClick={() => void load(positionRef.current)}
            >
              Refresh
            </Button>
          </>
        }
      />

      {assignTarget && (
        <IntradayManualAssignModal
          insertion={assignTarget}
          onClose={() => setAssignTarget(null)}
          onAssigned={() => {
            setAssignTarget(null);
            void load(positionRef.current);
          }}
        />
      )}
    </div>
  );
}
