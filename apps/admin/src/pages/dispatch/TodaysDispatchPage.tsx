import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { SE_UNAVAILABLE, type DispatchTodayView } from '../../api/dispatchToday';
import { EmptyState, PageHeader } from '../../components/data';
import { Badge } from '../../components/ui';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { useAuth } from '../../auth/AuthProvider';
import { cn } from '../../lib/cn';
import { AssignMode } from './console/AssignMode';
import { AttentionRail, AttentionStrip, useActionRequired } from './console/AttentionBand';
import { BoardGrid, type DropIntent } from './console/BoardGrid';
import { addDays, parseDayParam, visibleDays, type Span } from './console/dayAxis';
import { Inspector } from './console/Inspector';
import { ChooseZoneState, readLastZone, rememberZone, ZonePicker } from './console/ZonePicker';
import { RunNowControl } from './console/RunNowControl';
import { NextRunPill } from './console/NextRunPill';
import { encodeSelection, parseSelection, sameSelection, type Selection } from './console/selection';
import { useConsoleData } from './console/useConsoleData';
import { useDayContext } from './console/useDayContext';
import { GrammarLegend, type ChipDragPayload } from './console/WorkChip';
import { poolCounts, readRailOpen, rememberRailOpen, WorkRail, WorkRailHandle } from './console/WorkRail';

/**
 * The roles `POST /schedules/dispatch-run` serves. A ZM joined them in **#291**, together with the
 * server-side clamp that derives the zone from the caller instead of the body — the two are one change,
 * and this list must never be widened ahead of that clamp.
 */
const CAN_RUN_DISPATCH = ['CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD', 'ZONAL_MANAGER'];
/** The roles `GET /org/zones` serves, and therefore the roles that get a zone picker. */
const CAN_CHOOSE_ZONE = ['CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'];
/** Escalation rows shown before the strip collapses to a count — the full list is one click each. */
const ESCALATION_STRIP_ROWS = 6;

/**
 * The one shape every secondary control in the frame's second row wears.
 *
 * They are all the same kind of thing — a small toggle that opens or switches something — and until
 * 2026-09-01 they were drawn in three different weights: a bordered pill with its own caret, a button
 * carrying a long muted explainer inline that made it twice its neighbours' width, a `▾` disclosure,
 * and a lone `?`. A row of peers that does not look like a row of peers makes the operator re-read it
 * every time. The one control that departs from this is {@link AttentionStrip}, and only in colour —
 * its amber says work is waiting, which is a fact and not decoration.
 */
const FRAME_CONTROL =
  'rounded-md border border-line px-2 py-1 text-[11px] text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink';

/**
 * **The Scheduler Console** — one zone-scoped operational workspace (`/dispatch/today`).
 *
 * > The Console is the single zone-scoped operating-day workspace in which a manager sees what the
 * > engine did, understands why, sees what needs them, changes it, and sees the cost of the change —
 * > without leaving the screen.
 *
 * **Recomposed 2026-08-28** per the operator-approved composition correction
 * (`docs/audits/scheduler-console-ui-composition-correction.md`): the same data contracts, write
 * paths, RBAC clamps and honesty rules as the Phase 1–4 build, on the composition of a professional
 * workforce-scheduling product —
 *
 * - **The board is the canvas**: an ENGINEER × DAY grid takes all remaining width and height beside
 *   the one right-hand rail. Rows are engineers; columns are operating days. Its first column is the
 *   Console's only engineer representation (#295 — the separate People rail was deleted into it).
 * - **The day axis replaces the Plan / Live / Replay mode nav** (D9). A past column answers from the
 *   committed-schedule read, today from the one lifted `GET /dispatch/today` fetch — which is
 *   **never given a date** — and a future column from the projection. Each column says which mood it
 *   is in; `TODAY` is always one click away.
 * - **The top bar owns the frame**: zone, day navigation, find, run state, next run, Run Now, the
 *   attention strip and the run-facts / legend popovers. Nothing else is full-width except the rare
 *   recovery notice and the critical-escalation strip, which earn it.
 * - **The right rail is one slot with two occupants** — Work Pool by default, the Attention list on
 *   demand. The **contextual Inspector** is the bottom band, rendered only while something is
 *   selected (the direction's four-region shape; the empty placeholder is gone per correction §5.5).
 * - **Drag initiates, never commits** (D10): a legal drop opens the authoritative action dialog
 *   prefilled — same validation, impact preview and mandatory reason as the typed path.
 *
 * Role variance here is **rendering only**; every permission is enforced server-side already.
 * Controls a role does not have are **hidden, never disabled**.
 */
export default function TodaysDispatchPage() {
  const [params, setParams] = useSearchParams();
  const { session } = useAuth();
  const role = session?.role ?? '';
  const mayChooseZone = CAN_CHOOSE_ZONE.includes(role);

  // A ZM sends no zoneId: the backend resolves their own zone from the token and refuses any other.
  // A CSM/OH must name one — `parseZoneId` throws ZONE_REQUIRED rather than guessing — so the URL
  // wins, then the zone they last looked at, and failing both they get an explicit chooser.
  const zoneParam = params.get('zoneId') ?? undefined;
  const [rememberedZone] = useState(() => (mayChooseZone ? readLastZone() : null));
  const zoneId = zoneParam ?? (mayChooseZone ? (rememberedZone ?? undefined) : undefined);
  const mustChooseZone = mayChooseZone && !zoneId;

  const assigning = params.get('assign') === '1';
  const selection = parseSelection(params.get('sel'));
  const dayParam = parseDayParam(params.get('day'));
  const span: Span = params.get('span') === 'week' ? 'week' : 'day';
  const [filter, setFilter] = useState('');
  const findRef = useRef<HTMLInputElement>(null);
  const [railView, setRailView] = useState<'pool' | 'attention'>('pool');
  /**
   * **The right rail is collapsed by default** (operator ruling, 2026-09-01), remembered per operator.
   *
   * Composition rule 1 says the board is the only region that grows; a 20rem gutter that is always
   * there contradicts that for the ~90% of the day nobody is reading the pool. Collapsed it is an
   * icon carrying its own count, and one click brings it back — see {@link readRailOpen} for why this
   * is localStorage and not a URL param.
   *
   * The Attention list shares this slot and is opened *deliberately* from the top bar, so asking for
   * it opens the slot; there is no state in which the operator asks for a rail and gets a sliver.
   */
  const [railOpen, setRailOpenState] = useState(readRailOpen);
  const setRailOpen = (open: boolean) => {
    setRailOpenState(open);
    rememberRailOpen(open);
  };
  /**
   * Assign mode's own "may I leave?" guard, published by {@link AssignMode} while it is mounted.
   *
   * The escalation strip sits **below** the mode and stays visible inside it, which until now made
   * its verbs dead controls: clicking "Assign this work →" set `?sel=` and nothing rendered, because
   * the Inspector is not on screen in Assign mode. That is the field-ops P1 the composition
   * correction's §10 says the recomposition fixes. It is fixed by routing the verb through the mode's
   * own exit — which asks before discarding a draft — rather than by leaving it inert.
   */
  const exitGuardRef = useRef<((leave: () => void) => void) | null>(null);
  const [drag, setDrag] = useState<ChipDragPayload | null>(null);
  const [dropIntent, setDropIntent] = useState<DropIntent | null>(null);

  const { view, changes, loading, error, invalidate, version } = useConsoleData(zoneId, !mustChooseZone);
  const attention = useActionRequired(view?.zone.zoneId);

  const patchParams = useCallback(
    (mutate: (p: URLSearchParams) => void) => {
      const p = new URLSearchParams(params);
      mutate(p);
      setParams(p, { replace: true });
    },
    [params, setParams],
  );

  /**
   * §3.4 — entering Assign mode **drops the selection**, and leaving does not restore it.
   *
   * A selection is a committed object: the Inspector's whole subject, and an Actions band that
   * writes on confirm. Carrying one into a drafting surface would put immediate writes on the same
   * screen as lanes that write nothing, which is the one thing the mixed-commitment rule forbids.
   */
  const setAssigning = (next: boolean) =>
    patchParams((p) => {
      if (next) {
        p.set('assign', '1');
        p.delete('sel');
      } else {
        p.delete('assign');
      }
    });

  const setZone = (next: string) => {
    rememberZone(next);
    patchParams((p) => {
      p.set('zoneId', next);
      p.delete('sel'); // a selection from another zone's deck means nothing on this one
      // …and neither does a draft: Assign mode's pool is narrowed to the zone on screen (§14 D4),
      // and a client-side draft surviving the switch would stage the old zone's plants under the
      // new zone's heading. Leaving the mode is the honest answer.
      p.delete('assign');
    });
  };

  const select = useCallback(
    (next: Selection | null) => {
      setDropIntent(null); // a click is not a drop; a stale prefill must not reopen a dialog
      patchParams((p) => {
        if (next === null || sameSelection(next, selection)) p.delete('sel');
        else p.set('sel', encodeSelection(next));
      });
    },
    [patchParams, selection],
  );

  /** A legal drop selects the object *and* opens its dialog prefilled — one gesture, zero writes. */
  const onDropIntent = useCallback(
    (intent: DropIntent) => {
      setDropIntent(intent);
      patchParams((p) => p.set('sel', encodeSelection(intent.sel)));
    },
    [patchParams],
  );

  /**
   * **The drop's answer opens as an overlay, so there is nothing to scroll to.**
   *
   * This used to be a `scrollIntoView` plus a `ResizeObserver` that re-aimed it for two seconds as the
   * band grew. It existed because the Inspector was the band *underneath* a deck a screen or more
   * tall: a drop selected the object and seeded the dialog perfectly around 12,000px below the fold,
   * and the gesture was reported as "drag and drop is not working". It was working; its answer was
   * off-screen, which for an operator is the same thing.
   *
   * The Inspector is a modal overlay now (operator ruling, 2026-09-01), so the distance is gone rather
   * than chased: the answer opens over the board wherever the operator happens to be, and the board
   * keeps the scroll position they had. The whole effect went with the band — a scroll that now only
   * moves the page *behind* a modal is motion with no reader.
   */

  const setFocusedDay = (day: string) =>
    patchParams((p) => {
      if (view && day === view.operatingDay) p.delete('day');
      else p.set('day', day);
    });

  /**
   * **A write that moved work to another day takes the operator to that day — and puts the overlay away.**
   *
   * Every other override changes today's column, which the operator is already looking at, so
   * `invalidate` alone is the whole response. A cross-day move is the one write whose result lands
   * somewhere else — and a refetch that leaves them staring at the column the work just *left* is
   * indistinguishable, from their seat, from the move not happening. That was the entire complaint
   * about the old defer, and refetching harder does not fix it.
   *
   * Focusing the target day is also what makes the ticket *visible* rather than merely counted: a
   * focused future column renders committed work as chips, a context column renders it as a tally
   * (BoardGrid, §6.3 rule 5). One `?day=` change satisfies both, and costs the one projection/detail
   * fetch the operator has now explicitly asked for by moving work there.
   *
   * **Clearing the selection is what closes the overlay.** The Inspector is a modal now, and a modal
   * left standing over the very board change it just made is a wall between the operator and their own
   * result. The errand is finished on Confirm, so the overlay goes.
   *
   * **One params update, not three.** `select` and `setFocusedDay` each rebuild the query from the
   * same render's `params`, so calling them in sequence would have the second silently drop the
   * first's edit. The board also re-renders once this way rather than twice.
   */
  const onWriteCommitted = useCallback(
    (moved?: { day: string }) => {
      invalidate();
      setDropIntent(null); // a committed prefill must never re-open its dialog
      patchParams((p) => {
        p.delete('sel');
        if (!moved) return;
        if (view && moved.day === view.operatingDay) p.delete('day');
        else p.set('day', moved.day);
      });
    },
    [invalidate, patchParams, view],
  );
  const setSpan = (next: Span) =>
    patchParams((p) => {
      if (next === 'day') p.delete('span');
      else p.set('span', next);
    });

  // §3.5 — `/` focuses find, `Esc` peels back one layer: selection first, then the attention rail.
  // Deliberately nothing that fires a write: a shortcut that commits an irreversible override is out
  // of scope.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;
      if (e.key === '/' && !typing) {
        e.preventDefault();
        findRef.current?.focus();
      } else if (e.key === 'Escape') {
        if (typing && target === findRef.current) findRef.current?.blur();
        else if (selection) select(null);
        else setRailView('pool');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection, select]);

  const engineers = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!view) return [];
    if (!q) return view.engineers;
    // Filters, never fetches: every object on this screen is already in the one payload. An engineer
    // whose own name misses but who is carrying a matched plant or ticket stays, because hiding the
    // lane would hide the match.
    return view.engineers.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.stops.some(
          (s) =>
            s.plantName.toLowerCase().includes(q) ||
            s.tickets.some((t) => t.ticketId.toLowerCase().includes(q)),
        ),
    );
  }, [view, filter]);

  const today = view?.operatingDay ?? '';
  const focused = dayParam ?? today;
  const days = useMemo(() => (today ? visibleDays(focused, span) : []), [focused, span, today]);
  const rosterSeIds = useMemo(() => (view ? view.engineers.map((e) => e.seId) : []), [view]);

  const dayContext = useDayContext(view?.zone.zoneId ?? '', view ? days : [], today, focused, rosterSeIds, version);

  const zonePicker = mayChooseZone ? <ZonePicker value={zoneId} onChange={setZone} /> : null;

  if (mustChooseZone) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Scheduler Console" actions={zonePicker} />
        <ChooseZoneState hasZones />
      </div>
    );
  }

  if (loading && !view) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Scheduler Console" subtitle="Loading the operating day…" actions={zonePicker} />
        <div className="h-40 animate-pulse rounded-lg border border-line bg-surface-sunken" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Scheduler Console" actions={zonePicker} />
        <EmptyState
          message={`Could not load the operating day — ${error}`}
          action={<Button onClick={invalidate}>Try again</Button>}
        />
      </div>
    );
  }

  if (!view) return null;

  const run = view.run;

  return (
    <div className="flex flex-col gap-3">
      {/* ── TOP BAR — the whole frame in one compact strip ─────────────────────────────────── */}
      <header
        data-testid="console-top-bar"
        className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface px-3 py-2"
      >
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-sm font-semibold text-ink">Scheduler Console</h1>
          {zonePicker ?? <span className="text-[11px] text-ink-muted">{view.zone.name}</span>}

          {/* Day navigation — the axis that replaced the mode nav (D9). */}
          <nav aria-label="Operating day" className="flex items-center gap-0.5 rounded-md bg-surface-sunken p-0.5">
            <button
              type="button"
              data-testid="day-prev"
              onClick={() => setFocusedDay(addDays(focused, -1))}
              className="rounded px-1.5 py-0.5 text-[11px] text-ink-muted hover:text-ink"
            >
              ‹ Prev
            </button>
            <button
              type="button"
              data-testid="day-today"
              aria-current={focused === today}
              onClick={() => setFocusedDay(today)}
              className={[
                'rounded px-2 py-0.5 text-[11px]',
                focused === today ? 'bg-surface font-semibold text-ink shadow-sm' : 'text-ink-muted hover:text-ink',
              ].join(' ')}
            >
              TODAY
            </button>
            <button
              type="button"
              data-testid="day-next"
              onClick={() => setFocusedDay(addDays(focused, 1))}
              className="rounded px-1.5 py-0.5 text-[11px] text-ink-muted hover:text-ink"
            >
              Next ›
            </button>
          </nav>
          <nav aria-label="Span" className="flex items-center gap-0.5 rounded-md bg-surface-sunken p-0.5">
            {(['day', 'week'] as const).map((s) => (
              <button
                key={s}
                type="button"
                data-testid={`span-${s}`}
                aria-current={span === s}
                onClick={() => setSpan(s)}
                className={[
                  'rounded px-2 py-0.5 text-[11px] capitalize',
                  span === s ? 'bg-surface font-semibold text-ink shadow-sm' : 'text-ink-muted hover:text-ink',
                ].join(' ')}
              >
                {s}
              </button>
            ))}
          </nav>

          <label className="relative">
            <span className="sr-only">Find ticket or engineer</span>
            <Input
              ref={findRef}
              data-testid="console-find"
              className="h-7 w-40 text-xs"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Find ticket or SE  /"
            />
          </label>

          <span className="ml-auto flex flex-wrap items-center gap-2">
            {run ? (
              <Badge tone={run.status === 'SUCCESS' ? 'success' : run.status === 'RUNNING' ? 'info' : 'warning'} dot>
                {run.status === 'RUNNING'
                  ? 'Dispatch running'
                  : `Dispatched ${new Date(run.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${run.status}`}
              </Badge>
            ) : (
              <Badge tone="neutral">No run today</Badge>
            )}
            {/* B2 — a ZM could not answer "why is my deck empty at 04:55?" The hour is configurable,
                so it cannot be inferred, and this is the only place it is published. */}
            <NextRunPill />
            {/* CONTROL — a real trigger, not a link; hidden (never disabled) for roles without it. */}
            {CAN_RUN_DISPATCH.includes(role) && (
              <RunNowControl zoneId={view.zone.zoneId} zoneName={view.zone.name} onCompleted={invalidate} />
            )}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <AttentionStrip
            state={attention}
            expanded={railView === 'attention' && railOpen}
            onToggle={() => {
              // Asking for Attention opens the slot as well as switching it — a rail requested and
              // then served as a collapsed sliver is a dead control.
              const next = railView === 'attention' && railOpen ? 'pool' : 'attention';
              setRailView(next);
              if (next === 'attention') setRailOpen(true);
            }}
          />

          {!assigning && (
            <button
              type="button"
              data-testid="assign-mode-toggle"
              onClick={() => setAssigning(true)}
              // The explainer moved from inline text to the tooltip. It is worth saying and not worth
              // 180px of the frame's width every second of the day — inline it made this control
              // twice the size of the three peers beside it, which read as importance it does not
              // have over them.
              title="Hand out what the engine left"
              className={FRAME_CONTROL}
            >
              Assign work
            </button>
          )}

          {/* Run facts — the two nullable funnel counters keep their `—` ≠ 0 distinction here (B1),
              and the manual refresh lives beside them rather than competing with Run Now (§5.7). */}
          <details className="relative" data-testid="run-facts">
            <summary className={cn('cursor-pointer list-none', FRAME_CONTROL)}>Run facts ▾</summary>
            <div className="absolute z-20 mt-1 w-72 rounded-lg border border-line bg-surface p-3 shadow-lg">
              <SituationFacts view={view} />
              <Button className="mt-2" size="sm" variant="secondary" onClick={invalidate}>
                Refresh the operating day
              </Button>
            </div>
          </details>

          <details className="relative" data-testid="grammar-legend">
            <summary className={cn('cursor-pointer list-none', FRAME_CONTROL)} title="What the chips mean">
              ?
            </summary>
            <div className="absolute z-20 mt-1 w-80 rounded-lg border border-line bg-surface p-3 shadow-lg">
              <GrammarLegend />
            </div>
          </details>
        </div>
      </header>

      {/* ── HEALTH — properties of *this run of this zone*, not the cross-cutting queue ──────── */}
      {view.recovery && <RecoveryNotice recovery={view.recovery} />}

      {/* ── ASSIGN MODE — its own board region (§3.4, correction §10) ────────────────────────
          It replaces the board, both rails and the Inspector rather than sitting beside them:
          draft lanes and committed lanes may share a screen and a grammar but never a lane object.
          The frame above — zone, day, run state, attention, Run Now — stays throughout. */}
      {assigning ? (
        /* Keyed on the zone as a structural guarantee, not a convenience. The draft is client state
           and would otherwise survive a zone change, leaving the old zone's plants staged under the
           new zone's heading — one Commit from handing out another zone's work. The zone picker
           already leaves Assign mode outright, so this key should never fire; it is here so that no
           future path into a zone change can quietly reintroduce the defect. */
        <AssignMode
          key={view.zone.zoneId}
          view={view}
          filter={filter}
          onExit={() => setAssigning(false)}
          onCommitted={invalidate}
          exitGuardRef={exitGuardRef}
        />
      ) : (
        <>
          {/* ── BOARD │ WORK-or-ATTENTION ──────────────────────────────────────────────────────
              **Two regions, not three** (#295). The People rail stood here and rendered the same
              `engineers[]` array the board's first column renders — one array, one fetch, drawn
              twice. Its identity, coverage, workload and drop target now live in that column
              (`BoardGrid.EngineerRow`), which is what the reference personnel column shows and what
              gives the board back the width a work card needs. */}
          <div
            className={cn(
              'grid gap-3',
              // Collapsed, the second track is just wide enough for the handle, and every pixel it
              // gives up goes to the board — which is the whole point of the collapse.
              railOpen ? 'xl:grid-cols-[minmax(0,1fr)_20rem]' : 'xl:grid-cols-[minmax(0,1fr)_2.5rem]',
            )}
          >
            <div className="flex min-w-0 flex-col gap-1.5">
              <div className="flex items-baseline justify-between">
                <span className="text-[11px] text-ink-muted">
                  {engineers.length}
                  {filter.trim() && ` of ${view.engineers.length}`} engineers ·{' '}
                  <span className="tabular-nums">{view.situation.placed}</span> devices placed today
                </span>
              </div>
              {view.engineers.length === 0 ? (
                <EmptyState message="No engineers on this zone's roster yet." />
              ) : engineers.length === 0 ? (
                <EmptyState message={`No engineer, plant or ticket matches “${filter.trim()}”.`} />
              ) : (
                <BoardGrid
                  view={view}
                  engineers={engineers}
                  days={days}
                  focused={focused}
                  selection={selection}
                  onSelect={select}
                  context={dayContext}
                  drag={drag}
                  onDragChange={setDrag}
                  onDropIntent={onDropIntent}
                  onFocusDay={setFocusedDay}
                />
              )}
            </div>

            {/* One slot, three states — collapsed to a handle, the Work Pool, or Attention on
                demand. Never two at once. */}
            {!railOpen ? (
              <WorkRailHandle
                counts={poolCounts(view.rails, changes, filter)}
                onOpen={() => {
                  setRailView('pool');
                  setRailOpen(true);
                }}
                drag={drag}
                onDragChange={setDrag}
                onDropIntent={onDropIntent}
              />
            ) : railView === 'attention' ? (
              <AttentionRail state={attention} zoneName={view.zone.name} onClose={() => setRailView('pool')} />
            ) : (
              <WorkRail
                rails={view.rails}
                changes={changes}
                selection={selection}
                onSelect={select}
                filter={filter}
                chronicThreshold={view.chronicThreshold}
                drag={drag}
                onDragChange={setDrag}
                onDropIntent={onDropIntent}
                onCollapse={() => setRailOpen(false)}
              />
            )}
          </div>

          {/* ── CONTEXTUAL INSPECTOR — a modal overlay, rendered only while something is selected ── */}
          <Inspector
            selection={selection}
            view={view}
            onClose={() => select(null)}
            onCommitted={onWriteCommitted}
            prefill={dropIntent && selection && sameSelection(dropIntent.sel, selection) ? dropIntent.prefill : null}
          />
        </>
      )}

      {view.escalations.length > 0 && (
        <section
          data-testid="critical-interception"
          className="rounded-lg border-2 border-critical bg-critical-bg/40 px-3 py-2"
        >
          <h2 className="text-sm font-semibold text-critical">
            {view.escalations.length} critical{' '}
            {view.escalations.length === 1 ? 'ticket needs' : 'tickets need'} manual assignment
          </h2>
          {/* #288 — the capacity sentence is only printed when it is true of every row. Two causes now
              write an escalation: no capacity-eligible engineer (#268), and an engineer going
              unavailable on work already committed to them. One explanation over a mixed list would be
              wrong about half of it, so each row carries its own instead. */}
          {view.escalations.every((e) => e.insertionType !== SE_UNAVAILABLE) && (
            <p className="mt-0.5 text-[11px] text-ink-muted">
              No capacity-eligible engineer was available, so the scheduler escalated rather than
              overloading anyone.
            </p>
          )}
          <ul className="mt-1.5 flex flex-col gap-1">
            {/* Compact under the corrected composition: a zone can carry dozens of escalations, and a
                strip that scrolls the board off-screen defeats the board. The count above is the whole
                population; the rows below are the most recent slice, and every one resolves the same
                way — select, then assign or reassign from the Inspector. */}
            {view.escalations.slice(0, ESCALATION_STRIP_ROWS).map((e) => (
              <li key={e.insertionId} className="flex flex-wrap items-center gap-2 text-[11px]">
                <button
                  type="button"
                  className="font-mono text-link"
                  onClick={() => select({ kind: 'ticket', id: e.ticketId })}
                >
                  {e.ticketId.slice(0, 8)}
                </button>
                {e.slaBucket && <Badge tone="critical">{e.slaBucket.replace('_', ' ')}</Badge>}
                <span className="text-ink-muted">
                  escalated {new Date(e.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
                {e.insertionType === SE_UNAVAILABLE && (
                  <span className="text-ink">
                    {e.assignedSeName ?? e.assignedSeId ?? 'The assigned engineer'} is unavailable
                  </span>
                )}
                {/* Both doors are in the Inspector, so the row resolves in place (Phase 2.4):
                    stranded work is formally assigned and resolves to PLACED → Reassign; work nobody
                    holds resolves to UNPLACED → Assign. Selecting is one action either way. */}
                <button
                  type="button"
                  data-testid={`escalation-resolve-${e.ticketId}`}
                  className="ml-auto text-link"
                  onClick={() => {
                    // In Assign mode the Inspector is not on screen, so selecting alone did nothing.
                    // Leave the mode first — through the draft guard, so a staged draft is never
                    // discarded without the operator being told what they are giving up.
                    if (!assigning) return select({ kind: 'ticket', id: e.ticketId });
                    // One patch, not two: `setAssigning` and `select` each rebuild the query from the
                    // same render's `params`, so calling them in sequence would have the second put
                    // `assign=1` straight back.
                    const leave = () =>
                      patchParams((p) => {
                        p.delete('assign');
                        p.set('sel', encodeSelection({ kind: 'ticket', id: e.ticketId }));
                      });
                    if (exitGuardRef.current) exitGuardRef.current(leave);
                    else leave();
                  }}
                >
                  {assigning
                    ? 'Leave assigning and resolve →'
                    : e.assignedSeId
                      ? 'Reassign this work →'
                      : 'Assign this work →'}
                </button>
              </li>
            ))}
          </ul>
          {view.escalations.length > ESCALATION_STRIP_ROWS && (
            <p className="mt-1 text-[10px] text-ink-muted">
              …and {view.escalations.length - ESCALATION_STRIP_ROWS} more. Each resolves the same way —
              select it, then assign or reassign from the Inspector.
            </p>
          )}
        </section>
      )}
    </div>
  );
}

/**
 * B1 — the situation counters, relocated from the full-width strip into the run-facts popover and
 * the regions that own them (correction §4): placed lives on the board header, unassignable / held /
 * changes are the Work Pool's tab counts, over-capacity is per-engineer in the personnel column, and
 * critical is the interception strip. The two *nullable* funnel populations live here with their
 * `—` ≠ 0 distinction intact — null is "this run did not record it", never zero.
 */
function SituationFacts({ view }: { view: DispatchTodayView }) {
  const s = view.situation;
  // `sub` is printed, not tucked into a tooltip: "—" needs its explanation beside it, because "not
  // recorded" and "zero" are opposite claims and the dash alone does not say which this is.
  const rows: { label: string; value: string; hint?: string; sub?: string }[] = [
    { label: 'Placed', value: String(s.placed), hint: 'devices on a plan today' },
    { label: 'Unassignable', value: String(s.unassignable), hint: 'no eligible engineer' },
    { label: 'Held', value: String(s.held), hint: 'deferred past today' },
    { label: 'Critical needs you', value: String(s.criticalNeedsYou), hint: 'escalated to a human' },
    { label: 'Over capacity', value: String(s.overCapacity), hint: 'engineers at or past cap' },
    { label: 'Changes today', value: String(s.changesToday), hint: 'since dispatch' },
    {
      label: 'Component-blocked',
      value: s.componentBlockedWithheld == null ? '—' : String(s.componentBlockedWithheld),
      sub: s.componentBlockedWithheld == null ? 'not recorded by this run' : 'withheld — device blocked',
    },
    {
      label: 'No SLA bucket',
      value: s.bucketlessDropped == null ? '—' : String(s.bucketlessDropped),
      sub: s.bucketlessDropped == null ? 'not recorded by this run' : 'dropped before ranking',
    },
  ];
  return (
    <dl className="flex flex-col gap-1">
      {rows.map((r) => (
        <div key={r.label} className="text-[11px]">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-ink-muted" title={r.hint}>
              {r.label}
            </dt>
            <dd className="tabular-nums font-semibold text-ink">{r.value}</dd>
          </div>
          {r.sub && <p className="text-[10px] text-ink-muted">{r.sub}</p>}
        </div>
      ))}
    </dl>
  );
}

/**
 * #286 — what happened to a zone that lost its dispatch this morning.
 *
 * **#319 widened the cause, so the wording no longer names one.** The notice used to say "this zone's
 * dispatch run died", which was true while only the reaper could mark a zone. A zone is now also
 * marked when it throws *inside* a live run, or when its claim is still open as the run unwinds — in
 * both of those the run did not die, it finished and reported the loss. Saying "died" would send an
 * operator hunting for a crashed process that never existed, so the headline states the thing that is
 * true of every marked zone (it lost its dispatch) and `lastError` carries the specific reason
 * whenever the collector has one.
 *
 * Rendered above the deck rather than in the work rail on purpose: it is not a queue of work, it is a
 * statement about whether this zone's day is intact — the one thing besides the escalation strip that
 * keeps full width in the corrected composition, because it earns it. Four states, and the operator
 * has to be able to tell them apart at a glance —
 *  - `RECOVERED`: the system put it right by itself. Reassurance, not an alarm.
 *  - `PENDING`: still owed, and the collector will come back for it.
 *  - `EXHAUSTED`: the system tried its budget and stopped. Somebody has to look.
 *  - `EXPIRED`: the field day ran out first. The work did not happen and will not happen today.
 */
function RecoveryNotice({ recovery }: { recovery: NonNullable<DispatchTodayView['recovery']> }) {
  const needsAction = recovery.state === 'EXHAUSTED' || recovery.state === 'EXPIRED';
  const headline =
    recovery.state === 'RECOVERED'
      ? 'This zone lost its dispatch run and was automatically re-dispatched'
      : recovery.state === 'PENDING'
        ? 'This zone lost its dispatch run — a re-dispatch is queued'
        : recovery.state === 'EXHAUSTED'
          ? 'This zone lost its dispatch run and could not be recovered automatically'
          : 'This zone lost its dispatch run and the operating day ended before it could be recovered';

  return (
    <section
      data-testid="recovery-notice"
      className={[
        'rounded-lg border p-3',
        needsAction ? 'border-2 border-warning bg-warning-bg/40' : 'border-line bg-surface',
      ].join(' ')}
    >
      <h2 className={['text-sm font-semibold', needsAction ? 'text-warning' : 'text-ink'].join(' ')}>{headline}</h2>
      <p className="mt-0.5 text-[11px] text-ink-muted">
        Detected {new Date(recovery.markedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ·{' '}
        <span className="tabular-nums">{recovery.attempts}</span>{' '}
        {recovery.attempts === 1 ? 'attempt' : 'attempts'}
        {recovery.lastAttemptAt && (
          <>
            {' '}
            · last tried{' '}
            {new Date(recovery.lastAttemptAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </>
        )}
      </p>
      {recovery.lastError && <p className="mt-1 text-[11px] text-ink">{recovery.lastError}</p>}
      {needsAction && (
        <p className="mt-1 text-[11px] text-ink-muted">
          Nothing further will be attempted automatically today — run dispatch for this zone manually
          once the cause is cleared.
        </p>
      )}
    </section>
  );
}
