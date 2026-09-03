import { Link } from 'react-router-dom';
import type { DispatchTodayView, TodayEngineer, TodayHold } from '../../../api/dispatchToday';
import { Badge } from '../../../components/ui';
import { LoadBadge } from '../../../components/ui/LoadBadge';
import { cn } from '../../../lib/cn';
import { dayLabel, semanticOf, type DaySemantic } from './dayAxis';
import { dropAction, intentFor, type DropIntent } from './dropTargets';
import type { DayContext, DayCounts, DayProjection } from './useDayContext';
import type { Selection } from './selection';
import { WorkCard } from './WorkCard';
import { DRAG_MIME, GhostChip, type ChipDragPayload } from './WorkChip';

export type { DropIntent };

/**
 * **THE SCHEDULING BOARD — the Console's dominant canvas** (composition correction §2, approved
 * 2026-08-28).
 *
 * The board's axes are **ENGINEER × DAY**. Rows are engineers; columns are operating days; a cell
 * holds that engineer's stops and tickets for that day. This is the axis the rejected build was
 * missing — a scheduling board with no time axis is a work list.
 *
 * **Its first column is the Console's only engineer representation** (#295). It used to be a slim row
 * label beside a separate People rail that rendered the same `engineers[]` array; the rail is gone and
 * {@link EngineerRow} is the personnel column — see its own docblock for what it absorbed and, more
 * importantly, for what it must not drop.
 *
 * **Each column renders at the fidelity its source can honestly answer** (§6):
 *
 * - **Today** — full fidelity, from the one lifted `GET /dispatch/today` payload. The only mutable
 *   column, and the only one whose work takes actions and drags. Its unit is a {@link WorkCard}.
 * - **Past** — committed counts from `GET /schedules?date=`, rendered *as counts* with an explicit
 *   "counts only" affordance. Immutable: selection and drop are refused by construction, not by a
 *   permission error after the fact. Deliberately **not** enriched: the card's facts (inactivity,
 *   current names) are live-now facts, and painting them onto a day that has already happened would
 *   fabricate historical operational state.
 * - **Future** — committed rows where a live `WorkSchedule` already covers the date (committed beats
 *   projected, §6.3 rule 3), drawn as cards on the focused column once the batched identity read
 *   answers for them and as compact chips until it does; otherwise the recommender's projection as
 *   ghost chips, in conditional mood, with the `bucketsAsOf` watermark and **no write affordances**.
 *   Hold is the only pre-run lever and it lives on the Work Pool.
 *
 * **Drag is an initiator, never a commit** (D10). Releasing a chip on a legal cell opens the same
 * authoritative action dialog the typed path uses, prefilled; `Esc` or Cancel leaves the board
 * exactly as it was. An illegal cell simply never becomes a drop target — refusal is a cursor
 * state during the drag, not an error after it.
 */

const SEMANTIC_BADGE: Record<DaySemantic, { label: string; tone: 'neutral' | 'success' | 'info' }> = {
  past: { label: 'history', tone: 'neutral' },
  today: { label: 'LIVE', tone: 'success' },
  future: { label: 'projected', tone: 'info' },
};

export function BoardGrid({
  view,
  engineers,
  days,
  focused,
  selection,
  onSelect,
  context,
  drag,
  onDragChange,
  onDropIntent,
  onFocusDay,
}: {
  view: DispatchTodayView;
  /** The (possibly find-filtered) roster, in payload order — rule 2 of the composition. */
  engineers: TodayEngineer[];
  days: string[];
  focused: string;
  selection: Selection | null;
  onSelect: (sel: Selection | null) => void;
  context: DayContext;
  drag: ChipDragPayload | null;
  onDragChange: (p: ChipDragPayload | null) => void;
  onDropIntent: (intent: DropIntent) => void;
  onFocusDay: (day: string) => void;
}) {
  const today = view.operatingDay;

  // The focused column is the widest; context columns stay narrow.
  //
  // **The name column is a profile, and a profile is narrow.** It used to be `minmax(7rem, 8rem)` on
  // the reasoning that "the People rail already owns identity — the row label is an anchor, not a
  // profile"; #295 deleted that rail, so this column *is* the profile — avatar, name, load, coverage
  // and workload — and it was widened to `minmax(13rem, 18rem)` to lay all of that out in a row.
  //
  // That was the wrong axis. Laid out **vertically** (see {@link EngineerRow}) the same five facts
  // need about half the width, and the half it gives back goes where the operator actually works: the
  // focused day column, which has to hold a 2×2 work card per device. The operator's report on the
  // 18rem build was "the engineer column [is] too wide … it should be very compact".
  const template = [
    'minmax(8.5rem, 10rem)',
    ...days.map((d) => (d === focused ? 'minmax(18rem, 3fr)' : 'minmax(6.5rem, 1fr)')),
  ].join(' ');

  /** Committed rows on other days for engineers not on today's roster — a fact about those days. */
  const othersByDay = days.map((d) => context.counts[d]?.others ?? { engineers: 0, stops: 0, devices: 0 });
  const hasOthers = othersByDay.some((o) => o.engineers > 0);

  /** Held work, keyed by the day it returns — `heldUntil` is inclusive, so it IS live on that date. */
  const returningByDay = new Map<string, TodayHold[]>();
  for (const h of view.rails.held) {
    const on = returningByDay.get(h.heldUntil);
    if (on) on.push(h);
    else returningByDay.set(h.heldUntil, [h]);
  }
  const hasReturning = days.some((d) => (returningByDay.get(d)?.length ?? 0) > 0);

  return (
    <section data-testid="console-board" aria-label="Scheduling board" className="min-w-0">
      <div className="overflow-x-auto rounded-lg border border-line bg-surface">
        <div className="grid min-w-fit" style={{ gridTemplateColumns: template }}>
          {/* ── Column headers ─────────────────────────────────────────────────────────────── */}
          <div className="sticky left-0 z-10 border-b border-line bg-surface px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
            Engineer
          </div>
          {days.map((day) => (
            <DayHeader
              key={day}
              day={day}
              today={today}
              focused={focused === day}
              view={view}
              context={context}
              onFocusDay={onFocusDay}
              onSelect={onSelect}
            />
          ))}

          {/* ── Engineer rows ──────────────────────────────────────────────────────────────── */}
          {engineers.map((e, i) => (
            <EngineerRow
              key={e.seId}
              engineer={e}
              band={i % 2 === 1}
              days={days}
              focused={focused}
              today={today}
              view={view}
              context={context}
              selection={selection}
              onSelect={onSelect}
              drag={drag}
              onDragChange={onDragChange}
              onDropIntent={onDropIntent}
            />
          ))}

          {/*
            **Work coming BACK on this day** — the other direction of the day axis (operator request,
            2026-08-31).

            A defer takes work off today's board, and until now the board said nothing about where it
            went: three devices vanished and the operator read the silence as the decision being
            ignored. This row is the answer, and it is deliberately a *row* rather than a chip in
            somebody's cell.

            A deferred ticket is `assignmentState: UNASSIGNED` with no `assignedSeId` — **nobody holds
            it on the day it comes back.** Drawing it inside the cell of the engineer it was deferred
            *from* would claim they have it that day, which is false and is exactly what §6.3 exists to
            prevent: a column asserting more than its source can answer. So the row states the true
            thing — this much work lands back in play that day, owned by no one yet — and leaves the
            question of *who takes it* to the run that will actually decide.

            It reads `rails.held` off the one lifted payload, so it costs no fetch and needs no focus.
          */}
          {hasReturning && (
            <>
              <div className="sticky left-0 z-10 border-t border-line bg-surface px-2 py-1.5 text-[10px] font-medium text-ink">
                Returning
                <span className="block text-[9px] font-normal text-ink-muted">deferred back to this day</span>
              </div>
              {days.map((day) => (
                <ReturningCell
                  key={day}
                  day={day}
                  focused={focused === day}
                  holds={returningByDay.get(day) ?? []}
                  context={context}
                  onSelect={onSelect}
                />
              ))}
            </>
          )}

          {/* Committed work on other days held by engineers who are not on today's roster. */}
          {hasOthers && (
            <>
              <div className="sticky left-0 z-10 border-t border-line bg-surface px-2 py-1.5 text-[10px] text-ink-muted">
                Not on today's roster
              </div>
              {days.map((day, i) => {
                const o = othersByDay[i];
                return (
                  <div key={day} className={cn('border-t border-line px-2 py-1.5 text-[10px] text-ink-muted', day === focused && 'bg-surface-sunken/40')}>
                    {o.engineers > 0
                      ? `${o.engineers} ${o.engineers === 1 ? 'engineer' : 'engineers'} · ${o.devices} devices`
                      : '—'}
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * One day's returning work — how much lands back in play, and whether that day can actually take it.
 *
 * **The forecast half is the half that matters operationally.** Of three devices this Console's
 * operator deferred to the next day, the projection for that day already said **two of them had no
 * eligible engineer** — the postpone was going to fail again, and the board had no way to say so. A
 * cell that reports "3 coming back" and stops there teaches that deferring is free.
 *
 * The warning is drawn only from a **loaded** projection for that column, so it is a fact and never a
 * guess: no projection, no claim. That is the same rule the ghost chips follow, for the same reason.
 */
function ReturningCell({
  day,
  focused,
  holds,
  context,
  onSelect,
}: {
  day: string;
  focused: boolean;
  holds: TodayHold[];
  context: DayContext;
  onSelect: (sel: Selection | null) => void;
}) {
  const projection = context.projection[day];
  /** How many of *these* the day's own run would still fail to place. Only from a loaded projection. */
  const stranded =
    projection?.state === 'loaded' && projection.projection
      ? holds.filter((h) =>
          projection.projection!.decisions.some((d) => d.ticketId === h.ticketId && d.seId == null),
        ).length
      : null;

  return (
    <div
      data-testid={`returning-${day}`}
      className={cn('border-t border-l border-line px-1.5 py-1.5 align-top', focused && 'bg-surface-sunken/40')}
    >
      {holds.length === 0 ? (
        <p className="text-[10px] text-ink-muted">—</p>
      ) : (
        <>
          <p className="text-[10px] tabular-nums text-ink">
            {holds.length} {holds.length === 1 ? 'device' : 'devices'}
          </p>
          {stranded != null && stranded > 0 && (
            <p data-testid={`returning-stranded-${day}`} className="text-[10px] text-warning">
              {stranded === holds.length
                ? holds.length === 1
                  ? 'no engineer for it yet'
                  : 'none of them has an engineer yet'
                : `${stranded} of them still ${stranded === 1 ? 'has' : 'have'} no engineer yet`}
            </p>
          )}
          {/* Focused = full fidelity, the same rule the day columns follow (composition rule 5). Each
              row is a door to the same ticket the Work Pool's Held tab opens — one object, one
              Inspector, whichever door was used (§3.2). Release-the-hold lives there. */}
          {focused && (
            <ul className="mt-0.5 flex flex-col gap-0.5">
              {holds.map((h) => (
                <li key={h.ticketId}>
                  <button
                    type="button"
                    data-testid={`returning-open-${h.ticketId}`}
                    onClick={() => onSelect({ kind: 'ticket', id: h.ticketId })}
                    className="w-full truncate rounded px-1 text-left font-mono text-[10px] text-link hover:bg-surface-sunken"
                    title={`${h.plantName ?? 'plant not recorded'} — deferred, returns ${h.heldUntil}. Nobody holds it yet; that day’s run decides.`}
                  >
                    {h.deviceId ?? h.ticketId.slice(0, 8)}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/**
 * **What a future column's badge may honestly claim.**
 *
 * It used to read `projected` on every future column, unconditionally — a static label out of
 * `SEMANTIC_BADGE`, printed whether or not a projection had been fetched. Only the *focused* future
 * day ever runs one (`useDayContext` — it is the most expensive read the Console can issue), so a
 * context column three days out announced a forecast that did not exist and had never been asked for.
 *
 * That is not a cosmetic complaint. The cross-day drop lands on a column, and an operator reasonably
 * reads `projected` as "the system has an opinion about this day". Dropping onto a column labelled
 * with a forecast nobody computed is exactly the mismatch this whole change is about, one level up.
 *
 * So the badge now says which of the three things is actually true:
 * - **committed** — a live `WorkSchedule` covers this day (committed beats projected, §6.3 rule 3);
 * - **projected** — a projection was run for this day and these are its ghosts;
 * - **not projected** — nothing has been computed; focus the day to ask.
 */
function futureBadge(
  sem: DaySemantic,
  fallback: string,
  counts: DayCounts | undefined,
  projection: DayProjection | undefined,
): { label: string; title: string | undefined } {
  if (sem !== 'future') return { label: fallback, title: undefined };
  if (counts && Object.keys(counts.bySe).length > 0) {
    return { label: 'committed', title: 'Real assignments exist for this day — these are not a forecast.' };
  }
  if (projection?.state === 'loaded') {
    return { label: 'projected', title: 'What the run would do. Nothing here is committed.' };
  }
  return {
    label: 'not projected',
    title: 'No forecast has been run for this day. Focus the column to project it.',
  };
}

/**
 * A ticket already committed to a **future** day — the moved work, drawn as work.
 *
 * Deliberately not a {@link WorkChip}: that chip's grammar (provenance border, CRIT/RET/CHR tokens,
 * capacity cell) is fed by `TodayTicket`, which only today's lifted payload produces. Inventing those
 * channels from a day-scoped read would draw signals nobody computed — the one thing the grammar's
 * docblock forbids. This carries the two facts the day-scoped read genuinely has: the ticket, and
 * whether a person or the engine put it there.
 *
 * Solid, not dashed. A ghost chip is dashed because it is conditional; this is committed, and drawing
 * committed work in the conditional mood is the same class of lie in the other direction.
 */
function CommittedChip({
  ticketId,
  addSource,
  systemPlaced,
}: {
  ticketId: string;
  addSource: string | null;
  systemPlaced: boolean;
}) {
  const byHand = addSource != null && !systemPlaced;
  const moved = addSource === 'MANUAL_DAY_MOVE';
  return (
    <span
      data-testid={`committed-${ticketId}`}
      title={
        moved
          ? 'You moved this here. It is assigned on this day — not a forecast, and not deferred.'
          : byHand
            ? 'Assigned by a person for this day.'
            : 'Committed for this day.'
      }
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] tabular-nums',
        byHand ? 'border border-dashed border-ink-muted text-ink' : 'border border-line text-ink',
      )}
    >
      {moved && (
        <span data-testid={`committed-moved-${ticketId}`} aria-label="you moved this here">
          ⇥
        </span>
      )}
      {ticketId.slice(0, 8)}
    </span>
  );
}

function DayHeader({
  day,
  today,
  focused,
  view,
  context,
  onFocusDay,
  onSelect,
}: {
  day: string;
  today: string;
  focused: boolean;
  view: DispatchTodayView;
  context: DayContext;
  onFocusDay: (day: string) => void;
  onSelect: (sel: Selection | null) => void;
}) {
  const sem = semanticOf(day, today);
  const badge = SEMANTIC_BADGE[sem];
  const projection = context.projection[day];
  const futureLabel = futureBadge(sem, badge.label, context.counts[day], projection);

  return (
    <div
      data-testid={`day-column-${day}`}
      data-semantic={sem}
      className={cn('border-b border-l border-line px-2 py-1.5', focused && 'bg-surface-sunken/40')}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          data-testid={`day-focus-${day}`}
          onClick={() => onFocusDay(day)}
          className={cn('text-[11px] hover:text-link', focused ? 'font-semibold text-ink' : 'text-ink-muted')}
        >
          {dayLabel(day)}
        </button>
        <Badge tone={badge.tone} title={futureLabel.title}>
          {futureLabel.label}
        </Badge>
      </div>

      {focused && sem === 'today' && (
        <div className="mt-0.5 flex flex-wrap gap-x-3 text-[10px]">
          {view.run ? (
            <button
              type="button"
              data-testid="today-run-decisions"
              className="text-link"
              onClick={() => onSelect({ kind: 'run', id: view.run!.runId })}
            >
              Run decisions →
            </button>
          ) : (
            <span className="text-ink-muted">no run yet</span>
          )}
          <Link to="/dispatch-runs" className="text-link">
            All runs →
          </Link>
        </div>
      )}

      {focused && sem === 'past' && (
        <p className="mt-0.5 text-[10px] text-ink-muted">
          counts only ·{' '}
          <Link to="/dispatch-runs" className="text-link">
            open a run for detail →
          </Link>
        </p>
      )}

      {focused && sem === 'future' && (
        <div className="mt-0.5 text-[10px] text-ink-muted">
          {projection?.state === 'loaded' && projection.projection ? (
            <p data-testid={`projection-summary-${day}`}>
              {projection.projection.mode === 'DEFICIT' ? 'Catch-up mode' : projection.projection.mode === 'PREVENTIVE' ? 'Steady mode' : projection.projection.mode}
              {' · '}
              {projection.projection.recommended} would be assigned · {projection.projection.unassignable} unassignable ·{' '}
              {projection.projection.withheldBelowThreshold} withheld
              {projection.projection.bucketsAsOf && (
                <> · ranking as of {new Date(projection.projection.bucketsAsOf).toLocaleString()}</>
              )}
            </p>
          ) : projection?.state === 'loading' ? (
            <p>projecting…</p>
          ) : projection?.state === 'failed' ? (
            <p>the projection could not be read</p>
          ) : null}
          <Link to={`/schedules/preview?zoneId=${encodeURIComponent(view.zone.zoneId)}`} className="text-link">
            Open the full projection →
          </Link>
        </div>
      )}
    </div>
  );
}

/**
 * Deterministic initials, from the engineer's own name (#295).
 *
 * There is no profile-photo field anywhere in the schema — `users` has no photo column,
 * `engineer_master` has none, and `media_objects` is scoped to TROUBLESHOOT / VOUCHER / INSTALL work
 * with no profile slot. A migration for a decorative circle would be the wrong trade, so the avatar
 * is computed, exactly as `TopBar` already computes the session badge's initials. Same rule as that
 * one: first + last word, so "Ramesh Kulkarni" reads RK and a single-word name still gets two letters.
 */
function initialsOf(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length === 0) return '··';
  return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/**
 * **THE PERSONNEL COLUMN** (#295) — the Console's single engineer representation.
 *
 * It absorbed the People rail, which rendered the same `engineers[]` array in a second place. That
 * duplication was purely presentational — one array, one fetch — so deleting it could not
 * desynchronise anything; what it *could* do, and what this cell exists to prevent, is silently drop
 * the two things the rail alone carried:
 *
 * 1. **The drop target.** The rail shipped inert and was made droppable on 2026-08-31 because
 *    operators drag a device onto *the engineer's name in the list*, not onto a cell out in the grid.
 *    Reported then as "I can't drag and drop a device". The handlers moved here verbatim and call the
 *    **same** {@link dropAction} — never a second copy of "is this drop legal", because the day the
 *    two copies disagree the board and the roster answer differently about one gesture.
 * 2. **Coverage and workload** — the `DEDICATED` / `MULTI_PLANT` / `FLOATING` pill and the
 *    `n stops · n devices` line. Three coverage types, not two: FLOATING is a real population
 *    (territory-polygon SEs) and folding it into a neighbour would misreport who can go where.
 *
 * `committed / dailyCapacity` still comes from `committedDayPlan` by way of the payload — this cell
 * must never recompute a load from the stops it can see, because a number an operator reads as "can
 * they carry it?" has to be the number the engine will enforce.
 *
 * The whole cell is one button, as the rail's row was: click selects the engineer, and a drop
 * anywhere on it means *this engineer, today*.
 */
function EngineerRow({
  engineer,
  band,
  days,
  focused,
  today,
  view,
  context,
  selection,
  onSelect,
  drag,
  onDragChange,
  onDropIntent,
}: {
  engineer: TodayEngineer;
  /**
   * Every other row, tinted. A hairline `border-t` is the whole of what separated fifteen lanes
   * across an 1,100px board, and following one engineer from the pinned name column to the far
   * column meant holding a line with your eye. The band is the faintest surface step in the scale —
   * enough to trace a row, not enough to compete with the action-status fills the cards carry, which
   * sit on top of it and keep their meaning.
   */
  band: boolean;
  days: string[];
  focused: string;
  today: string;
  view: DispatchTodayView;
  context: DayContext;
  selection: Selection | null;
  onSelect: (sel: Selection | null) => void;
  drag: ChipDragPayload | null;
  onDragChange: (p: ChipDragPayload | null) => void;
  onDropIntent: (intent: DropIntent) => void;
}) {
  const laneSelected = selection?.kind === 'engineer' && selection.id === engineer.seId;
  const unavailable = engineer.availability !== 'AVAILABLE';
  const ticketCount = engineer.stops.reduce((n, s) => n + s.tickets.length, 0);
  /** What a drop here would open, asked of the same predicate the board's cells ask. */
  const prefill = drag ? dropAction(drag, engineer.seId, today, today) : null;

  return (
    <>
      <div
        className={cn(
          // `bg-*` is not optional on a sticky cell: it slides over the scrolling columns and would
          // otherwise show them through. The band picks which of the two it is.
          'sticky left-0 z-10 border-t border-line px-1.5 py-1.5',
          band ? 'bg-surface-raised' : 'bg-surface',
          laneSelected && 'bg-brand-50/40',
        )}
      >
        <button
          type="button"
          aria-pressed={laneSelected}
          data-testid={`lane-${engineer.seId}`}
          onClick={() => onSelect(laneSelected ? null : { kind: 'engineer', id: engineer.seId })}
          onDragOver={(ev) => {
            if (!prefill) return;
            ev.preventDefault();
            ev.dataTransfer.dropEffect = 'move';
          }}
          onDrop={(ev) => {
            const raw = ev.dataTransfer.getData(DRAG_MIME);
            const payload: ChipDragPayload | null = raw ? (JSON.parse(raw) as ChipDragPayload) : drag;
            onDragChange(null);
            if (!payload) return;
            // Re-asked against the dropped payload rather than trusting the render's `prefill`: the
            // drag in flight at paint time and the one actually released need not be the same, and
            // only the payload on the event is authoritative.
            const action = dropAction(payload, engineer.seId, today, today);
            if (!action) return;
            ev.preventDefault();
            const intent = intentFor(payload, action);
            if (intent) onDropIntent(intent);
          }}
          className={cn(
            // Stacked, centred, and read top-to-bottom: avatar → name → workload → tags. Horizontal
            // was the shape a wide column invited; this is the shape the compact one wants, and it is
            // the personnel treatment the reference board uses.
            'flex w-full flex-col items-center gap-0.5 rounded-md border px-1 py-1 text-center transition-colors',
            laneSelected ? 'border-brand-600' : 'border-transparent hover:border-line hover:bg-surface-sunken',
            // The same outline the board's cells use, so one gesture reads the same in both places
            // rather than having to be learnt twice.
            prefill && 'outline-dashed outline-1 -outline-offset-2 outline-brand-600',
          )}
        >
          {/* The identity anchor, and sized like one. At `h-7` it read as a bullet beside the name;
              the operator's report was that it "is too small". */}
          <span
            aria-hidden
            data-testid={`avatar-${engineer.seId}`}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-[12px] font-semibold text-ink-muted"
          >
            {initialsOf(engineer.name)}
          </span>
          <span className="w-full min-w-0 truncate text-[12px] font-medium leading-tight text-ink">
            {engineer.name}
          </span>
          <span className="w-full truncate text-[10px] tabular-nums leading-tight text-ink-muted">
            {engineer.stops.length} {engineer.stops.length === 1 ? 'stop' : 'stops'} · {ticketCount}{' '}
            {ticketCount === 1 ? 'device' : 'devices'}
          </span>
          <span className="flex flex-wrap items-center justify-center gap-1 text-[10px] text-ink-muted">
            <Badge tone="neutral">{engineer.coverageType.replace(/_/g, ' ')}</Badge>
            <LoadBadge committed={engineer.committed} dailyCapacity={engineer.dailyCapacity} seId={engineer.seId} />
          </span>
          {/* Unavailability is stated and the work is not hidden: #282 R4 is escalate-only, so an
              engineer on leave still holds what they hold. */}
          {unavailable && (
            <span className="text-[10px] leading-tight text-warning">
              {engineer.availability.replace(/_/g, ' ').toLowerCase()}
            </span>
          )}
        </button>
      </div>
      {days.map((day) => (
        <BoardCell
          key={day}
          engineer={engineer}
          band={band}
          day={day}
          focused={focused === day}
          today={today}
          view={view}
          context={context}
          selection={selection}
          onSelect={onSelect}
          drag={drag}
          onDragChange={onDragChange}
          onDropIntent={onDropIntent}
        />
      ))}
    </>
  );
}

/**
 * One engineer's cell for one day. The amber treatment is the grammar's capacity channel — a cell
 * property, deliberately not a chip property, because capacity is a fact about the engineer's day.
 */
function BoardCell({
  engineer,
  band,
  day,
  focused,
  today,
  view,
  context,
  selection,
  onSelect,
  drag,
  onDragChange,
  onDropIntent,
}: {
  engineer: TodayEngineer;
  /** See {@link EngineerRow}'s note — the row's banding, carried across every column. */
  band: boolean;
  day: string;
  focused: boolean;
  today: string;
  view: DispatchTodayView;
  context: DayContext;
  selection: Selection | null;
  onSelect: (sel: Selection | null) => void;
  drag: ChipDragPayload | null;
  onDragChange: (p: ChipDragPayload | null) => void;
  onDropIntent: (intent: DropIntent) => void;
}) {
  const sem = semanticOf(day, today);
  const droppable = drag != null && dropAction(drag, engineer.seId, day, today) != null;
  /** Tickets the operator deferred *to* this day — used to mark their own decision on the forecast. */
  const returningHere = new Set(view.rails.held.filter((h) => h.heldUntil === day).map((h) => h.ticketId));
  /** #295 — batched card identity for this column, when one was fetched and answered. */
  const summaries = context.summaries[day]?.byTicket;

  const dropProps = {
    onDragOver: (e: React.DragEvent) => {
      if (drag && dropAction(drag, engineer.seId, day, today)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      }
    },
    onDrop: (e: React.DragEvent) => {
      const raw = e.dataTransfer.getData(DRAG_MIME);
      const payload: ChipDragPayload | null = raw ? (JSON.parse(raw) as ChipDragPayload) : drag;
      onDragChange(null);
      if (!payload) return;
      const prefill = dropAction(payload, engineer.seId, day, today);
      if (!prefill) return;
      e.preventDefault();
      const intent = intentFor(payload, prefill);
      if (intent) onDropIntent(intent);
    },
  };

  const base = cn(
    'border-t border-l border-line px-1.5 py-1.5 align-top',
    band && 'bg-surface-raised',
    // Ordered so the meaningful tints win over the decorative one: a focused column and an
    // over-capacity cell both say something, the band only helps the eye track a row.
    focused && 'bg-surface-sunken/40',
    sem === 'today' && engineer.overCapacity && 'bg-warning-soft/40',
    droppable && 'outline-dashed outline-1 -outline-offset-2 outline-brand-600',
  );

  if (sem === 'today') {
    return (
      <div data-testid={`cell-${engineer.seId}-${day}`} className={base} {...dropProps}>
        {engineer.availability !== 'AVAILABLE' && (
          <p className="mb-1 rounded bg-surface-sunken px-1.5 py-0.5 text-[10px] text-ink-muted">
            {engineer.availability.replace(/_/g, ' ').toLowerCase()} — work below still stands
          </p>
        )}
        {engineer.stops.length === 0 ? (
          <p className="text-[10px] text-ink-muted">{engineer.overCapacity ? 'no stops' : 'no stops — available'}</p>
        ) : (
          <ol className="flex flex-col gap-1">
            {engineer.stops.map((stop) => (
              <li key={stop.batchId} className="min-w-0">
                <div
                  className={cn(
                    'flex items-baseline gap-1 text-[11px]',
                    selection?.kind === 'stop' && selection.id === stop.batchId && 'rounded bg-brand-50/60 ring-1 ring-brand-600',
                  )}
                >
                  <span className="font-mono text-ink-muted">{stop.stopSequence}</span>
                  <button
                    type="button"
                    aria-pressed={selection?.kind === 'stop' && selection.id === stop.batchId}
                    data-testid={`stop-${stop.batchId}`}
                    draggable
                    onDragStart={(e) => {
                      const payload: ChipDragPayload = { type: 'stop', batchId: stop.batchId, fromSeId: engineer.seId };
                      e.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
                      e.dataTransfer.effectAllowed = 'move';
                      onDragChange(payload);
                    }}
                    onDragEnd={() => onDragChange(null)}
                    onClick={() =>
                      onSelect(
                        selection?.kind === 'stop' && selection.id === stop.batchId
                          ? null
                          : { kind: 'stop', id: stop.batchId },
                      )
                    }
                    /* Sized to its own text, not `flex-1`. Stretching the name across the whole cell
                       pushed the `adjusted` badge to the far edge of a 563px focused column, ~500px
                       from the stop it is about, where it read as belonging to the column rather than
                       to this stop. `min-w-0` keeps a long plant name truncating rather than shoving
                       the badge out. */
                    className="min-w-0 cursor-grab truncate text-left font-medium text-ink hover:text-link active:cursor-grabbing"
                  >
                    {stop.plantName}
                  </button>
                  {/*
                    **What `adjusted` is allowed to mean.** `OVERRIDDEN` says a person changed this
                    stop today — a ticket withdrawn, deferred, reassigned, or moved to another day.
                    That is a true and useful thing to say, and it stays.

                    What it must NOT be read as is "the ticket you moved is still here, in a modified
                    form". It never was: `GET /dispatch/today` filters `removed_at: null`, so the
                    moved ticket's chip is gone from this stop, and a stop whose every ticket left is
                    dropped from the payload entirely. The badge marks the *stop that remains* because
                    its other devices are still there.

                    Under the old defer wiring that reading was almost impossible to avoid — the
                    ticket had gone somewhere the board could not draw, so `adjusted` was the only
                    visible trace of the whole operation and naturally absorbed its meaning. Now the
                    work appears on the day it moved to, and this badge is left saying only its own
                    much smaller thing. The tooltip says which thing that is.
                  */}
                  {stop.status === 'OVERRIDDEN' && (
                    <Badge tone="warning" title="A person changed this stop today. Any work that left it has gone to whoever and whenever they sent it — it is not still here.">
                      adjusted
                    </Badge>
                  )}
                </div>
                {/*
                  **The card tray — a grid, not a stack** (operator, 2026-09-01, second pass).

                  #295 stacked cards one per row on the reasoning that a five-fact block laid out as
                  chips tiles into an unreadable wall. That was true of a five-fact block; the card is
                  now three rows wide enough to read at ~10.5rem, and one-per-row turned a fifteen
                  device stop into a scroll for an operator whose whole job is seeing the day at once.

                  `auto-fill` rather than a fixed column count, because the same cell is ~260px on the
                  focused column of a laptop and half a screen on a monitor — a hard `grid-cols-2`
                  would be too tight at one and wasteful at the other. `minmax(…, 1fr)` lets the last
                  row's cards stretch rather than leaving a ragged gap.
                */}
                {focused && (
                  <div className="grid gap-1 pl-3 pt-0.5 [grid-template-columns:repeat(auto-fill,minmax(10.5rem,1fr))]">
                    {stop.tickets.map((t) => (
                      <WorkCard
                        key={t.ticketId}
                        variant="live"
                        ticket={t}
                        agingThresholdHours={view.agingThresholdHours}
                        chronicThreshold={view.chronicThreshold}
                        selected={selection?.kind === 'ticket' && selection.id === t.ticketId}
                        onSelect={onSelect}
                        draggable
                        dragPayload={{ type: 'ticket', ticketId: t.ticketId, batchId: stop.batchId, fromSeId: engineer.seId }}
                        onDragChange={onDragChange}
                      />
                    ))}
                  </div>
                )}
                {!focused && stop.tickets.length > 0 && (
                  <p className="pl-3 text-[10px] tabular-nums text-ink-muted">{stop.tickets.length} devices</p>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    );
  }

  // Past and future columns. `droppable` can only be true here for a cross-day MOVE (future).
  const counts = context.counts[day];
  const mine = counts?.bySe[engineer.seId];
  const projection = context.projection[day];
  const projectedPlants =
    sem === 'future' && !mine && projection?.state === 'loaded'
      ? (projection.projection?.plan.find((p) => p.seId === engineer.seId)?.plants ?? [])
      : [];

  /**
   * **Committed future work, drawn as the work it is** — the second half of the cross-day-move fix.
   *
   * A move writes a real `work_schedules` row for the target day, so this cell's source can now
   * answer at ticket fidelity, and rendering it as `1 stop · 1 device` would be under-reporting what
   * the read returned. §6.3's "each column renders at the fidelity its source can honestly answer"
   * cuts both ways: a column may not claim more than its source knows, and it should not hide what
   * its source does know.
   *
   * Only on the **focused** column, which is rule 5 unchanged — a context column stays a strip of
   * counts, and a successful move takes the operator to the day it landed on, so the ticket they
   * moved is on screen either way.
   */
  const committedStops = focused && sem === 'future' ? (mine?.plan ?? []) : [];

  return (
    <div data-testid={`cell-${engineer.seId}-${day}`} className={base} {...dropProps}>
      {!counts || counts.state === 'loading' ? (
        <p className="text-[10px] text-ink-muted">…</p>
      ) : counts.state === 'failed' ? (
        <p className="text-[10px] text-ink-muted">could not read this day</p>
      ) : committedStops.length > 0 ? (
        <div className="flex flex-col gap-1">
          {committedStops.map((stop) => (
            <div key={stop.batchId} className="min-w-0">
              <p className="flex items-baseline gap-1 text-[11px]">
                <span className="font-mono text-ink-muted">{stop.stopSequence}</span>
                <span className="min-w-0 flex-1 truncate font-medium text-ink">{stop.plantName}</span>
              </p>
              {/*
                **Committed future work, at whatever fidelity its source reached** (#295).

                A card where the batched summary answered for this ticket; the compact chip where it
                did not — the request is still in flight, it failed, or the id was outside the zone.
                The fallback is deliberate and is not a loading state: a full card frame with five
                blank rows would claim facts nobody fetched, which is the same class of lie the
                provenance grammar exists to prevent. The chip says exactly what the day-scoped read
                genuinely knows, as it always did.
              */}
              <div className="grid gap-1 pl-3 pt-0.5 [grid-template-columns:repeat(auto-fill,minmax(10.5rem,1fr))]">
                {stop.tickets.map((t) => {
                  const summary = summaries?.[t.ticketId];
                  return summary ? (
                    <WorkCard
                      key={t.ticketId}
                      variant="committed"
                      ticketId={t.ticketId}
                      summary={summary}
                      addSource={t.addSource}
                      systemPlaced={t.systemPlaced}
                      coverageTypeAtAssign={t.coverageTypeAtAssign}
                      selected={selection?.kind === 'ticket' && selection.id === t.ticketId}
                      onSelect={onSelect}
                    />
                  ) : (
                    <CommittedChip
                      key={t.ticketId}
                      ticketId={t.ticketId}
                      addSource={t.addSource}
                      systemPlaced={t.systemPlaced}
                    />
                  );
                })}
              </div>
            </div>
          ))}
          <Badge tone="neutral">committed</Badge>
        </div>
      ) : mine ? (
        <div className="text-[10px] text-ink">
          <span aria-hidden className="tracking-tighter text-ink-muted">
            {'●'.repeat(Math.min(mine.stops, 8))}
          </span>
          <p className="tabular-nums">
            {mine.stops} {mine.stops === 1 ? 'stop' : 'stops'} · {mine.devices} devices
          </p>
          {sem === 'future' && <Badge tone="neutral">committed</Badge>}
        </div>
      ) : projectedPlants.length > 0 ? (
        <div className="flex flex-col gap-1">
          {projectedPlants.map((p) => (
            <div key={p.plantId} className="flex flex-wrap gap-1">
              {p.ticketIds.map((t) => (
                <GhostChip key={t} ticketId={t} deferred={returningHere.has(t)} />
              ))}
            </div>
          ))}
        </div>
      ) : sem === 'future' && focused && projection?.state === 'loading' ? (
        <p className="text-[10px] italic text-ink-muted">projecting…</p>
      ) : sem === 'future' && !focused ? (
        <p className="text-[10px] text-ink-muted">—</p>
      ) : (
        <p className="text-[10px] text-ink-muted">—</p>
      )}
    </div>
  );
}
