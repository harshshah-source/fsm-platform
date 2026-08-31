import type { TodayEngineer } from '../../../api/dispatchToday';
import { Badge } from '../../../components/ui';
import { LoadBadge } from '../../../components/ui/LoadBadge';
import { cn } from '../../../lib/cn';
import { dropAction, intentFor, type DropIntent } from './dropTargets';
import type { Selection } from './selection';
import { DRAG_MIME, type ChipDragPayload } from './WorkChip';

/**
 * **ENGINEERS / PEOPLE — the Console's left rail** (approved structure, 2026-08-27).
 *
 * The board answers *"who is carrying what, in what order"*. This rail answers the question that
 * precedes it: *"who have I got today, and how loaded are they?"* — identity, coverage, capacity,
 * workload and status, for every engineer on the zone's roster, in one scannable column that does not
 * scroll away when the board does.
 *
 * **It is a projection of the same `.engineers[]` array the board renders**, minus the stops. Not a
 * second fetch and not a second source: the load a manager reads here has to be the load the board
 * shows and the load the recommender enforces, and the only way to guarantee that is for all three to
 * be the same numbers from the same payload.
 *
 * **`committed` / `dailyCapacity` come from `committedDayPlan`** — the same function dispatch itself
 * uses to decide whether an engineer can take more work (#269). This rail must never recompute a load
 * from the stops it can see: a number an operator reads as *"can this engineer carry it?"* has to be
 * the number the engine will actually enforce, and a client-side sum would drift the moment work
 * exists that this view does not render.
 *
 * **Unavailability is stated, and the work is not hidden.** An engineer on leave with committed work
 * still holds that work — #282 R4 is escalate-only, so nothing is silently reassigned — and the rail
 * says both things rather than dropping the row or zeroing the load.
 *
 * **It is also a drop target (2026-08-31).** It shipped inert, which made the most intuitive gesture
 * on the screen do nothing: wanting to move a device to Vivek Saini, an operator drags it onto *Vivek
 * Saini* — the name, in this list — not onto his cell out in the grid. The drop landed on a rail with
 * no handler, nothing happened, and there was no way to find out why. Reported as "I can't drag and
 * drop a device".
 *
 * A row here means **this engineer, today**, which is exactly the board's today-column semantics, so
 * the legality question is answered by {@link dropAction} — the *same* function the board calls, not
 * a second copy of it. The drag contract (§12/D10) is unchanged: nothing is written on release, the
 * authoritative dialog opens prefilled, and an illegal drop never becomes a target at all.
 */
export function PeopleRail({
  engineers,
  selection,
  onSelect,
  today,
  drag,
  onDragChange,
  onDropIntent,
}: {
  engineers: TodayEngineer[];
  selection: Selection | null;
  onSelect: (sel: Selection | null) => void;
  /** The operating day. A row here always means *today* — this rail shows today's roster and load. */
  today?: string;
  drag?: ChipDragPayload | null;
  onDragChange?: (p: ChipDragPayload | null) => void;
  onDropIntent?: (intent: DropIntent) => void;
}) {
  const selectedSeId = selection?.kind === 'engineer' ? selection.id : null;

  /** What this row would open if the thing currently being dragged were released on it. */
  const actionFor = (seId: string) =>
    drag && today && onDropIntent ? dropAction(drag, seId, today, today) : null;

  return (
    <section
      data-testid="console-people-rail"
      aria-label="Engineers"
      className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3"
    >
      <h2 className="flex items-baseline justify-between text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
        Engineers
        <span className="tabular-nums text-ink">{engineers.length}</span>
      </h2>

      {engineers.length === 0 ? (
        <p className="text-[11px] text-ink-muted">No engineers on this zone's roster yet.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {engineers.map((e) => {
            const selected = selectedSeId === e.seId;
            const unavailable = e.availability !== 'AVAILABLE';
            const ticketCount = e.stops.reduce((n, s) => n + s.tickets.length, 0);
            const prefill = actionFor(e.seId);
            return (
              <li key={e.seId}>
                <button
                  type="button"
                  data-testid={`person-${e.seId}`}
                  aria-pressed={selected}
                  onClick={() => onSelect(selected ? null : { kind: 'engineer', id: e.seId })}
                  onDragOver={(ev) => {
                    if (!prefill) return;
                    ev.preventDefault();
                    ev.dataTransfer.dropEffect = 'move';
                  }}
                  onDrop={(ev) => {
                    const raw = ev.dataTransfer.getData(DRAG_MIME);
                    const payload: ChipDragPayload | null = raw
                      ? (JSON.parse(raw) as ChipDragPayload)
                      : (drag ?? null);
                    onDragChange?.(null);
                    if (!payload || !today || !onDropIntent) return;
                    // Re-asked against the dropped payload rather than trusting the render's `prefill`:
                    // the drag in flight at paint time and the one actually released need not be the
                    // same, and only the payload on the event is authoritative.
                    const action = dropAction(payload, e.seId, today, today);
                    if (!action) return;
                    ev.preventDefault();
                    const intent = intentFor(payload, action);
                    if (intent) onDropIntent(intent);
                  }}
                  className={cn(
                    'w-full rounded-md border px-2 py-1.5 text-left transition-colors',
                    selected
                      ? 'border-brand-600 bg-brand-50/40'
                      : 'border-transparent hover:border-line hover:bg-surface-sunken',
                    // The same treatment the board's cells use, so one gesture reads the same in both
                    // places rather than being learned twice.
                    prefill && 'outline-dashed outline-1 -outline-offset-2 outline-brand-600',
                  )}
                >
                  <span className="flex items-baseline gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink">
                      {e.name}
                    </span>
                    <LoadBadge committed={e.committed} dailyCapacity={e.dailyCapacity} seId={e.seId} />
                  </span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-ink-muted">
                    <Badge tone="neutral">{e.coverageType.replace(/_/g, ' ')}</Badge>
                    <span className="tabular-nums">
                      {e.stops.length} {e.stops.length === 1 ? 'stop' : 'stops'} · {ticketCount}{' '}
                      {ticketCount === 1 ? 'device' : 'devices'}
                    </span>
                    {unavailable && (
                      <span className="text-warning">{e.availability.replace(/_/g, ' ').toLowerCase()}</span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
