import { useEffect, useMemo, useState, type MutableRefObject } from 'react';
import type { DispatchTodayView } from '../../../api/dispatchToday';
import type { ZoneEngineer } from '../../../api/schedules';
import { Button } from '../../../components/ui/Button';
import { useAssignDraft } from '../../assign/useAssignDraft';
import { AssignBoard } from './AssignBoard';

/**
 * **Assign mode** — the Scheduler Console's own working context for handing out work (slice §13
 * Phase 4, approved as §14 **D2**, scoped by §14 **D4**; recomposed 2026-08-31 per the composition
 * correction's §10).
 *
 * ## The mixed-commitment rule (§3.4), which is why this is a *mode*
 *
 * Draft chips and committed lane chips are the same shape and mean opposite things. A chip placed in
 * a draft lane **writes nothing** and is lost when the operator navigates away (#272 R2/Q2); a ticket
 * moved on the committed board **writes immediately**. The shared grammar's first rule is *never the
 * same shape for two meanings*, and the rule D2's approval was made conditional on is:
 *
 * > Draft work and committed work may share a screen, a frame and a grammar. They may **never share
 * > a lane object.**
 *
 * So this region **replaces** the board, both rails and the Inspector rather than sitting beside
 * them. That is the rule made structural instead of conventional, and it settles three things at
 * once:
 *
 *  - A committed lane (`lane-<seId>`, written on change) and a draft lane (`draft-lane-<seId>`,
 *    written on commit) are never on screen together. There is no drag to forbid because there is
 *    nowhere to drag to (§3.3 — no drag between the two vocabularies).
 *  - The Work rail and the Assign pool are two *different predicates* over "unassigned work" — the
 *    rail holds what the engine refused, the pool holds what a manual assign would move right now.
 *    Side by side, under one zone heading, that is two panes answering one question differently.
 *  - The Inspector's subject is a committed object and its Actions band writes on confirm. It has
 *    nothing to say about a draft, and offering immediate writes beside lanes that write nothing is
 *    exactly the confusion the rule exists to prevent.
 *
 * **What §10 corrected — and what this file now does.** *Replacing the board* was read, in the Phase 4
 * build, as *replacing the workspace*: the Console swapped in `/assign`'s own three-column page. The
 * rule never asked for that. It asks that the two lane **vocabularies** never co-exist, which is
 * satisfied by draft lanes occupying the board's region — in the board's own composition, beside the
 * board's own roster. {@link AssignBoard} is that composition; this file is the frame around it.
 *
 * **The frame stays.** Zone, operating day, run state, the situation counters, Run Now, the attention
 * strip and the health line are all above this region and are all still true while drafting — the
 * operator never loses which zone and which day they are standing in.
 *
 * ## Zone scope (D4)
 *
 * The pool is narrowed to the deck's zone and the roster comes from the Console's own lifted payload.
 * Both narrowings exist for one reason: `GET /schedules/assignable-work` **and**
 * `GET /schedules/engineers` answer pan-India for a CSM or Operations Head who is not acting in a
 * zone. The pan-India pool stays reachable, unchanged, on the standalone `/assign` route.
 */
export function AssignMode({
  view,
  filter,
  onExit,
  onCommitted,
  exitGuardRef,
}: {
  view: DispatchTodayView;
  /** The frame's find box (§3.5) — it filters the pool here as it filters the board in normal mode. */
  filter: string;
  onExit: () => void;
  /** The Console's single lifted fetch (§8.4) — a commit here invalidates every other region. */
  onCommitted: () => void;
  /**
   * The page's handle on {@link guardedLeave}, so a control *outside* this region — the escalation
   * strip's "resolve this" verb, which has to take the operator back to the Inspector — can leave
   * Assign mode through the same question rather than dropping the draft silently. A ref rather than
   * a callback prop because the page reads it at click time, not at render time.
   */
  exitGuardRef?: MutableRefObject<((leave: () => void) => void) | null>;
}) {
  /**
   * The deck's roster as lane targets.
   *
   * A projection, not a second read: `committed` is the same figure the board's own load badges show,
   * from `committedDayPlan` — the definition the recommender enforces against (#269). Two counts of
   * one engineer's day on one screen is the defect that definition exists to prevent, and the Console
   * would be the surface most able to show both at once.
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

  /**
   * The draft is owned **here**, one level above the board, for one reason: the exit control has to be
   * able to ask whether there is anything to lose. A draft that dies silently when somebody clicks
   * away is the behaviour #272 Q2 ruled acceptable; a draft that dies silently *without saying so* is
   * the behaviour this mode was reported for.
   *
   * Keyed on the zone by the caller (see below), so a zone change gets a fresh machine rather than
   * one holding another zone's plants.
   */
  const draft = useAssignDraft({ zoneId: view.zone.zoneId, engineers, onCommitted });

  /** Non-null while the operator has asked to leave and there is a draft standing in the way. */
  const [confirming, setConfirming] = useState<null | (() => void)>(null);

  /**
   * Leaving with work staged asks first — and the question is asked in consequences, not in storage
   * terms. This is the honest half of #272 Q2: the ruling is that a draft is session-local and dies
   * when you leave, not that it should die *without the operator being told which N devices they are
   * about to un-stage*.
   *
   * With an empty draft there is nothing to confirm and no dialog appears, which is the common case.
   */
  const guardedLeave = (leave: () => void) => {
    if (draft.isDirty) setConfirming(() => leave);
    else leave();
  };

  // Published in an effect, never during render: handing a parent a fresh closure mid-render is a
  // write to another component while this one is rendering. The ref is read on click, long after.
  useEffect(() => {
    if (!exitGuardRef) return;
    exitGuardRef.current = guardedLeave;
    return () => {
      exitGuardRef.current = null;
    };
  });

  return (
    <section data-testid="console-assign-mode" className="flex flex-col gap-3">
      {/* The mode header is outside the board and therefore constant across drafting *and* review:
          which zone, that this is a drafting context, and the way out — all three have to be in the
          same place on both stages. The explanation of *what a draft is* has moved down into the
          stage ribbon, where it can be shown with numbers instead of described in prose. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-dashed border-brand-600 bg-brand-300/10 px-3 py-2">
        <span className="text-sm font-semibold text-ink">Assigning work · {view.zone.name}</span>
        <span className="text-[11px] text-ink-muted">
          The board is showing what you are about to hand out, not what is on anyone's plan.
        </span>
        <Button
          data-testid="assign-mode-exit"
          className="ml-auto"
          size="sm"
          variant="secondary"
          onClick={() => guardedLeave(onExit)}
        >
          Back to today's board
        </Button>
      </div>

      {confirming && (
        <div
          role="alertdialog"
          aria-label="Leave without committing?"
          data-testid="assign-exit-confirm"
          className="flex flex-wrap items-center gap-3 rounded-lg border-2 border-warning bg-warning-bg/40 px-3 py-2"
        >
          <span className="text-sm text-ink">
            <b>{draft.inDraft.open}</b> {draft.inDraft.open === 1 ? 'device is' : 'devices are'} selected for{' '}
            <b>{draft.readyLanes.length}</b> {draft.readyLanes.length === 1 ? 'engineer' : 'engineers'} and{' '}
            <b>nothing has been written</b>. Leaving now hands out none of it.
          </span>
          <span className="ml-auto flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => setConfirming(null)}>
              Keep drafting
            </Button>
            <Button
              size="sm"
              data-testid="assign-exit-discard"
              onClick={() => {
                const leave = confirming;
                setConfirming(null);
                leave();
              }}
            >
              Leave and discard
            </Button>
          </span>
        </div>
      )}

      <AssignBoard view={view} draft={draft} filter={filter} />
    </section>
  );
}
