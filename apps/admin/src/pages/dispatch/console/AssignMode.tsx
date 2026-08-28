import { useMemo } from 'react';
import type { DispatchTodayView } from '../../../api/dispatchToday';
import type { ZoneEngineer } from '../../../api/schedules';
import { Button } from '../../../components/ui/Button';
import { AssignWorkspace } from '../../assign/AssignWorkspace';

/**
 * **Assign mode** — the Scheduler Console's own board region for handing out work
 * (slice §13 Phase 4, approved as §14 **D2**, scoped by §14 **D4**).
 *
 * ## The mixed-commitment rule (§3.4), which is why this is a *mode*
 *
 * `/assign` chips and Console lane chips are the same shape and mean opposite things. A chip placed
 * in a draft lane **writes nothing** and is lost when the operator navigates away (#272 R2/Q2); a
 * ticket moved on the committed board **writes immediately**. The shared grammar's first rule is
 * *never the same shape for two meanings*, and the rule D2's approval was made conditional on is:
 *
 * > Draft work and committed work may share a screen, a frame and a grammar. They may **never share
 * > a lane object.**
 *
 * So this region **replaces** the board, both rails and the Inspector rather than sitting beside
 * them. That is the rule made structural instead of conventional, and it settles three things at
 * once:
 *
 *  - A committed lane (`lane-<seId>`, written on change) and a draft lane (`lane-<n>`, written on
 *    commit) are never on screen together. There is no drag to forbid because there is nowhere to
 *    drag to (§3.3 — no drag in v1 regardless).
 *  - The Work rail and the Assign pool are two *different predicates* over "unassigned work" — the
 *    rail holds what the engine refused, the pool holds what a manual assign would move right now.
 *    Side by side, under one zone heading, that is the same class of defect B5 fixed for the
 *    attention band: two panes on one screen answering one question differently.
 *  - The Inspector's subject is a committed object and its Actions band writes on confirm. It has
 *    nothing to say about a draft, and offering immediate writes beside lanes that write nothing is
 *    exactly the confusion the rule exists to prevent.
 *
 * **The frame stays.** Zone, operating day, run state, the six situation counters, Run Now and the
 * health line are all above this region and are all still true while drafting — the operator never
 * loses which zone and which day they are standing in.
 *
 * ## Zone scope (D4)
 *
 * The pool is narrowed to the deck's zone and the roster comes from the Console's own lifted
 * payload. Both narrowings exist for one reason: `GET /schedules/assignable-work` **and**
 * `GET /schedules/engineers` answer pan-India for a CSM or Operations Head who is not acting in a
 * zone. The pan-India pool stays reachable, unchanged, on the standalone `/assign` route.
 */
export function AssignMode({
  view,
  onExit,
  onCommitted,
}: {
  view: DispatchTodayView;
  onExit: () => void;
  /** The Console's single lifted fetch (§8.4) — a commit here invalidates every other region. */
  onCommitted: () => void;
}) {
  /**
   * The deck's roster as lane targets.
   *
   * A projection, not a second read: `committed` is the same figure the board's own load badges
   * show, from `committedDayPlan` — the definition the recommender enforces against (#269). Two
   * counts of one engineer's day on one screen is the defect that definition exists to prevent, and
   * the Console would be the surface most able to show both at once.
   *
   * The roster is already `isActive: true` server-side, which is what makes that field a fact here
   * rather than an assumption.
   */
  const engineers = useMemo<ZoneEngineer[]>(
    () =>
      view.engineers.map((e) => ({
        engineerId: e.seId,
        name: e.name,
        coverageType: e.coverageType,
        zoneId: view.zone.zoneId,
        committed: e.committed,
        dailyCapacity: e.dailyCapacity,
        isActive: true,
      })),
    [view.engineers, view.zone.zoneId],
  );

  return (
    <section data-testid="console-assign-mode" className="flex flex-col gap-3">
      {/* The banner is outside the workspace and therefore constant across drafting *and* review:
          "nothing is written yet" is true of both stages, and the way out has to be in the same
          place on both. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-dashed border-brand-600 bg-brand-300/10 px-3 py-2">
        <span className="text-sm font-semibold text-ink">Assign mode · {view.zone.name}</span>
        <span className="text-[11px] text-ink-muted">
          Unassigned work in this zone, what you are about to hand out, and what will be left. Nothing
          is written until you commit — this draft lives in this browser tab only.
        </span>
        <Button
          data-testid="assign-mode-exit"
          className="ml-auto"
          size="sm"
          variant="secondary"
          onClick={onExit}
        >
          Exit assign mode
        </Button>
      </div>

      {/* Keyed on the zone as a structural guarantee, not a convenience. The draft is client state
          and would otherwise survive a zone change, leaving the old zone's plants staged under the
          new zone's heading — one Commit from handing out another zone's work. The zone picker
          already leaves Assign mode outright, so this key should never fire; it is here so that no
          future path into a zone change can quietly reintroduce the defect. */}
      <AssignWorkspace
        key={view.zone.zoneId}
        zoneId={view.zone.zoneId}
        engineers={engineers}
        onCommitted={onCommitted}
      />
    </section>
  );
}
