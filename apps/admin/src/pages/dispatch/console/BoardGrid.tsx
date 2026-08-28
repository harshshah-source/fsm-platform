import { Link } from 'react-router-dom';
import type { DispatchTodayView, TodayEngineer } from '../../../api/dispatchToday';
import { Badge } from '../../../components/ui';
import { LoadBadge } from '../../../components/ui/LoadBadge';
import { cn } from '../../../lib/cn';
import type { ActionPrefill } from './ActionsBand';
import { dayLabel, semanticOf, type DaySemantic } from './dayAxis';
import type { DayContext } from './useDayContext';
import type { Selection } from './selection';
import { DRAG_MIME, GhostChip, WorkChip, type ChipDragPayload } from './WorkChip';

/**
 * **THE SCHEDULING BOARD — the Console's dominant canvas** (composition correction §2, approved
 * 2026-08-28).
 *
 * The board's axes are **ENGINEER × DAY**. Rows are engineers, in the same order as the People rail;
 * columns are operating days; a cell holds that engineer's stops and tickets for that day. This is
 * the axis the rejected build was missing — a scheduling board with no time axis is a work list.
 *
 * **Each column renders at the fidelity its source can honestly answer** (§6):
 *
 * - **Today** — full fidelity, from the one lifted `GET /dispatch/today` payload. The only mutable
 *   column, and the only one whose chips take actions and drags.
 * - **Past** — committed counts from `GET /schedules?date=`, rendered *as counts* with an explicit
 *   "counts only" affordance. Immutable: selection and drop are refused by construction, not by a
 *   permission error after the fact.
 * - **Future** — committed counts where a live `WorkSchedule` already covers the date (committed
 *   beats projected, §6.3 rule 3); otherwise the recommender's projection as ghost chips, in
 *   conditional mood, with the `bucketsAsOf` watermark and **no write affordances**. Hold is the
 *   only pre-run lever and it lives on the Work Pool.
 *
 * **Drag is an initiator, never a commit** (D10). Releasing a chip on a legal cell opens the same
 * authoritative action dialog the typed path uses, prefilled; `Esc` or Cancel leaves the board
 * exactly as it was. An illegal cell simply never becomes a drop target — refusal is a cursor
 * state during the drag, not an error after it.
 */

export interface DropIntent {
  sel: Selection;
  prefill: ActionPrefill;
}

/** What a drop on `(engineer, day)` would legally initiate — or null, which refuses the drop. */
export function dropAction(
  p: ChipDragPayload,
  seId: string,
  day: string,
  today: string,
): ActionPrefill | null {
  const sem = semanticOf(day, today);
  if (p.type === 'ticket') {
    if (sem === 'today' && seId !== p.fromSeId) return { action: 'REASSIGN', seId };
    // Same engineer, a later day = "do it then, not today" — the DEFER_TICKET override, date prefilled.
    if (sem === 'future' && seId === p.fromSeId) return { action: 'DEFER_TICKET', date: day };
    return null;
  }
  if (p.type === 'pool') return sem === 'today' ? { action: 'ASSIGN', seId } : null;
  if (p.type === 'stop') return sem === 'today' && seId !== p.fromSeId ? { action: 'SWAP_SE', seId } : null;
  return null;
}

function intentFor(p: ChipDragPayload, prefill: ActionPrefill): DropIntent | null {
  if (p.type === 'stop' && p.batchId) return { sel: { kind: 'stop', id: p.batchId }, prefill };
  if (p.ticketId) return { sel: { kind: 'ticket', id: p.ticketId }, prefill };
  return null;
}

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
  /** The (possibly find-filtered) roster, in People-rail order — rule 2 of the composition. */
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

  // The focused column is the widest; context columns are narrow. The name column is slim because
  // the People rail already owns identity — the row label is an anchor, not a profile.
  const template = [
    'minmax(7rem, 8rem)',
    ...days.map((d) => (d === focused ? 'minmax(16rem, 3fr)' : 'minmax(6.5rem, 1fr)')),
  ].join(' ');

  /** Committed rows on other days for engineers not on today's roster — a fact about those days. */
  const othersByDay = days.map((d) => context.counts[d]?.others ?? { engineers: 0, stops: 0, devices: 0 });
  const hasOthers = othersByDay.some((o) => o.engineers > 0);

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
          {engineers.map((e) => (
            <EngineerRow
              key={e.seId}
              engineer={e}
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
        <Badge tone={badge.tone}>{sem === 'future' && context.counts[day] && Object.keys(context.counts[day].bySe).length > 0 ? 'committed' : badge.label}</Badge>
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

function EngineerRow({
  engineer,
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

  return (
    <>
      <div
        className={cn(
          'sticky left-0 z-10 border-t border-line bg-surface px-2 py-1.5',
          laneSelected && 'bg-brand-50/40',
        )}
      >
        <button
          type="button"
          aria-pressed={laneSelected}
          data-testid={`lane-${engineer.seId}`}
          onClick={() => onSelect(laneSelected ? null : { kind: 'engineer', id: engineer.seId })}
          className="w-full truncate text-left text-[12px] font-medium text-ink hover:text-link"
        >
          {engineer.name}
        </button>
        <div className="mt-0.5">
          <LoadBadge committed={engineer.committed} dailyCapacity={engineer.dailyCapacity} seId={engineer.seId} />
        </div>
      </div>
      {days.map((day) => (
        <BoardCell
          key={day}
          engineer={engineer}
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
                    className="min-w-0 flex-1 truncate text-left font-medium text-ink hover:text-link"
                  >
                    {stop.plantName}
                  </button>
                  {stop.status === 'OVERRIDDEN' && <Badge tone="warning">adjusted</Badge>}
                </div>
                {focused && (
                  <div className="flex flex-wrap gap-1 pl-3 pt-0.5">
                    {stop.tickets.map((t) => (
                      <WorkChip
                        key={t.ticketId}
                        ticket={t}
                        selected={selection?.kind === 'ticket' && selection.id === t.ticketId}
                        onSelect={onSelect}
                        chronicThreshold={view.chronicThreshold}
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

  // Past and future columns. `droppable` can only be true here for the DEFER case (future, same SE).
  const counts = context.counts[day];
  const mine = counts?.bySe[engineer.seId];
  const projection = context.projection[day];
  const projectedPlants =
    sem === 'future' && !mine && projection?.state === 'loaded'
      ? (projection.projection?.plan.find((p) => p.seId === engineer.seId)?.plants ?? [])
      : [];

  return (
    <div data-testid={`cell-${engineer.seId}-${day}`} className={base} {...dropProps}>
      {!counts || counts.state === 'loading' ? (
        <p className="text-[10px] text-ink-muted">…</p>
      ) : counts.state === 'failed' ? (
        <p className="text-[10px] text-ink-muted">could not read this day</p>
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
                <GhostChip key={t} ticketId={t} />
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
