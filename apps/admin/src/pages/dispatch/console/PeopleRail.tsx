import type { TodayEngineer } from '../../../api/dispatchToday';
import { Badge } from '../../../components/ui';
import { LoadBadge } from '../../../components/ui/LoadBadge';
import { cn } from '../../../lib/cn';
import type { Selection } from './selection';

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
 */
export function PeopleRail({
  engineers,
  selection,
  onSelect,
}: {
  engineers: TodayEngineer[];
  selection: Selection | null;
  onSelect: (sel: Selection | null) => void;
}) {
  const selectedSeId = selection?.kind === 'engineer' ? selection.id : null;

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
            return (
              <li key={e.seId}>
                <button
                  type="button"
                  data-testid={`person-${e.seId}`}
                  aria-pressed={selected}
                  onClick={() => onSelect(selected ? null : { kind: 'engineer', id: e.seId })}
                  className={cn(
                    'w-full rounded-md border px-2 py-1.5 text-left transition-colors',
                    selected
                      ? 'border-brand-600 bg-brand-50/40'
                      : 'border-transparent hover:border-line hover:bg-surface-sunken',
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
