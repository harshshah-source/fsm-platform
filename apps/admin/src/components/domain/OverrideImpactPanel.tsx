import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { Badge } from '../ui/Badge';

import type {
  OverrideImpact,
  OverrideLaneImpact,
  OverrideRankContext,
  OverrideImpactConflicts,
  OverrideRouteImpact,
} from '../../api/schedules';

/**
 * #289 — the design's step 3: **what this move would do, before it is done.**
 *
 * The approved flow is inspect → understand → override → **preview impact** → confirm (#282 R1). This
 * is the fourth step: it renders `POST /api/batches/:id/override/preview`, which writes nothing, and
 * it renders it *between* choosing a target SE and pressing Confirm.
 *
 * **Operator ruling, 2026-08-25:** the panel lives on Schedule Detail, not the cockpit — `/dispatch/today`
 * has no override controls and links out to here, so building them there would duplicate an existing
 * surface (#282 R5). AC5's "the cockpit renders the preview" is superseded by that ruling.
 *
 * Three rules the panel is built on, each of them somebody's earlier decision:
 *
 * - **Over capacity is stated, never a barrier** (#258 Q2). Manual overload is an administrative
 *   right, so the amber marking is the whole of the treatment — this component renders no button and
 *   disables nothing. A preview that gated the move would be the refusal that ruling forbids.
 * - **Amber, never crimson** (#290). Crimson is critical work in #272's grammar table; over capacity
 *   is a state. One colour, one meaning, across every surface.
 * - **Null is unknown, never "unranked"** (#283). A rank the run never recorded is a sentence this
 *   panel does not print, rather than a position it invents.
 *
 * It re-derives nothing: every figure here is the backend's projection, computed from the same
 * `committedDayPlan` the recommender enforces against.
 */
export function OverrideImpactPanel({ impact }: { impact: OverrideImpact }) {
  return (
    <div
      data-testid="override-impact"
      className="mt-2 flex w-full flex-col gap-3 rounded-card border border-line bg-surface-card p-3"
    >
      <div data-testid="impact-header" className="flex flex-wrap items-center gap-2 border-b border-line pb-2">
        <span className="text-xs font-bold text-ink-strong">
          {impact.ticketIds.length === 1 ? '1 ticket' : `${impact.ticketIds.length} tickets`} at {impact.plantName}
        </span>
        <span className="text-xs text-ink-muted">
          {(impact.from.seName ?? impact.from.seId) + ' → ' + (impact.to.seName ?? impact.to.seId)}
        </span>
        <span className="ml-auto">
          {/* #283's provenance grammar, said *before* the write rather than only after it: what the
              operator is about to do will be recorded as a human decision, not a system one.

              **Neutral, where the design draws this chip amber.** #272's grammar table gives amber
              exactly one meaning — over capacity — and this pill would otherwise sit inches from the
              amber lane below it, in the same shape, meaning something else entirely. That collision
              is the defect #290 spent a slice removing from `/assign`; re-introducing it here for
              literal fidelity would trade the rule for the drawing. Violet was not the answer either:
              the table spends it on "a human crossed a coverage tier", which this move need not be.
              The words carry the meaning; no colour has to. */}
          <Badge tone="neutral">Human override</Badge>
        </span>
      </div>

      <section className="flex flex-col gap-2">
        <h4 className="text-[0.65rem] font-bold uppercase tracking-wider text-ink-caps">Capacity impact</h4>
        <Lane lane={impact.from} />
        <Lane lane={impact.to} />
      </section>

      <dl className="flex flex-col gap-1.5">
        <SystemView rank={impact.rank} targetName={impact.to.seName ?? impact.to.seId} targetSeId={impact.to.seId} />
        <Row label="Route" testId="impact-route">
          {routeSentence(impact.route, impact.to.seName ?? impact.to.seId, impact.plantName)}
        </Row>
        <Conflicts conflicts={impact.conflicts} ticketIds={impact.ticketIds} />
      </dl>
    </div>
  );
}

/**
 * One engineer's day, before → after. `7/8 → 6/8`.
 *
 * An engineer with no `dailyCapacity` set shows a bare count and no bar: painting somebody
 * permanently overloaded because their master row was never given a number is the failure mode
 * `LoadBadge` already refuses, and this reads the same way for the same reason.
 */
function Lane({ lane }: { lane: OverrideLaneImpact }) {
  const cap = lane.dailyCapacity;
  const has = typeof cap === 'number' && cap > 0;
  const reading = has ? `${lane.committed}/${cap} → ${lane.after}/${cap}` : `${lane.committed} → ${lane.after}`;

  return (
    <div
      data-testid={`impact-lane-${lane.seId}`}
      data-over-capacity={String(lane.overCapacity)}
      className="flex items-center gap-3 text-xs"
    >
      <span className="w-24 shrink-0 truncate font-semibold text-ink-strong" title={lane.seId}>
        {lane.seName ?? lane.seId}
      </span>
      {has && (
        <span aria-hidden className="flex h-2 flex-1 overflow-hidden rounded-full bg-neutral-bg">
          <span
            className="bg-ink-muted"
            style={{ width: `${(Math.min(lane.committed, lane.after) / cap) * 100}%` }}
          />
          <span
            className={lane.overCapacity ? 'bg-warning/60' : 'bg-ink-muted/40'}
            style={{ width: `${(Math.abs(lane.after - lane.committed) / cap) * 100}%` }}
          />
        </span>
      )}
      <span
        className={`shrink-0 tabular-nums font-semibold ${lane.overCapacity ? 'text-warning' : 'text-ink-strong'}`}
        {...(lane.overCapacity ? { title: 'At or over capacity — the move is still allowed' } : {})}
      >
        {reading}
      </span>
    </div>
  );
}

/** The label column of the design's three sentence rows — one word, so the sentences line up. */
function Row({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  return (
    <div data-testid={testId} className="flex gap-2 text-xs">
      <dt className="w-20 shrink-0 pt-px text-[0.62rem] font-bold uppercase tracking-wider text-ink-caps">
        {label}
      </dt>
      <dd className="text-ink">{children}</dd>
    </div>
  );
}

/**
 * "Sneha ranked #2 for this ticket in run 900" — the engine's own opinion of the engineer you are
 * about to hand the work to, read from the run's decision trace rather than re-scored here.
 *
 * **Silence is the answer when the run recorded nothing.** No rank, no row: a ticket placed by hand,
 * a run predating the trace, or a target that was never in the candidate pool all mean the engine has
 * no opinion to report, and "unranked" would be read as one it does have (#283). The design's wording
 * names the run by its start time; this names it by its id, because that is what the projection
 * carries — the link goes to the run, where the time is.
 */
function SystemView({
  rank,
  targetName,
  targetSeId,
}: {
  rank: OverrideRankContext | null;
  targetName: string;
  targetSeId: string;
}) {
  if (!rank) return null;
  const chosen = rank.chosenSeId === targetSeId;
  const placed = rank.targetPrecedenceRank;
  if (!chosen && placed === null && rank.targetVerdict === null) return null;

  const run = (
    <Link to={`/dispatch-runs/${rank.runId}`} className="text-link hover:underline">
      run {rank.runId}
    </Link>
  );

  return (
    <Row label="System view" testId="impact-rank">
      {chosen ? (
        <>
          {targetName} was the choice {run} made for this ticket
        </>
      ) : placed !== null ? (
        <>
          {targetName} ranked #{placed} for this ticket in {run}
          {rank.targetVerdict === 'DROPPED' && rank.targetDropReason
            ? ` — dropped: ${rank.targetDropReason}`
            : null}
        </>
      ) : (
        <>
          {run} recorded {targetName} as {rank.targetVerdict}
          {rank.targetDropReason ? ` — ${rank.targetDropReason}` : null}
        </>
      )}
    </Row>
  );
}

/**
 * What the move does to the target's route, in the design's words: "Appended as stop 3 — her route is
 * not reordered". The promise is the point of the sentence, so it is **stated rather than implied**:
 * `moveTickets` appends and never renumbers, and a panel that merely omitted the question would leave
 * the operator no way to know that.
 *
 * The design writes the engineer's pronoun; this writes the route's. Nothing in the system records an
 * engineer's pronouns, and a name is not one.
 */
function routeSentence(route: OverrideRouteImpact, targetName: string, plantName: string): string {
  if (route.joinsExistingStop) {
    return `Joins stop ${route.appendedAsStop} at ${plantName}, which ${targetName} already makes — no new stop is added`;
  }
  if (route.targetScheduleId === null) {
    return `Opens a new day plan for ${targetName} — this work is stop ${route.appendedAsStop}`;
  }
  return `Appended as stop ${route.appendedAsStop} on the chain for ${targetName} — existing stops are not reordered`;
}

/**
 * The two gates the confirm will apply, read ahead of it — and **reported, not enforced.**
 *
 * Both are confirm-and-reason gates on the write, never refusals, so this row changes nothing about
 * whether the move can be made; it changes whether the manager making it knew. Hiding a conflicted
 * move would be the preview lying about what the operator is allowed to do.
 *
 * `onSite` reads empty until `soft_states` exists (Issue 15). The row is written for the day it does
 * not, rather than being added then — a preview that silently omitted a gate the write applies is the
 * failure this whole panel exists to prevent.
 */
function Conflicts({ conflicts, ticketIds }: { conflicts: OverrideImpactConflicts; ticketIds: string[] }) {
  const clear = conflicts.onSite.length === 0 && conflicts.deferred.length === 0;

  return (
    <Row label="Conflicts" testId="impact-conflicts">
      {clear ? (
        <span className="text-success">
          None — no on-site work, no return-date hold on {ticketIds.join(', ')}
        </span>
      ) : (
        <span className="flex flex-col gap-0.5 text-warning">
          {conflicts.onSite.length > 0 && <span>On-site work in progress: {conflicts.onSite.join(', ')}</span>}
          {conflicts.deferred.length > 0 && <span>Return-date hold: {conflicts.deferred.join(', ')}</span>}
          <span className="text-ink-muted">
            Stated, not blocked — the confirm records your reason against it.
          </span>
        </span>
      )}
    </Row>
  );
}
