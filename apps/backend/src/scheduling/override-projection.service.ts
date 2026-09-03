import { Inject, Injectable, Optional } from '@nestjs/common';
import { istDate } from '../common/ist-day';
import { PrismaService } from '../prisma/prisma.service';
import { committedDayPlan } from './committed-day-load';
import type { OverrideCommand } from './override.service';
import {
  NoConflictSoftStatePort,
  SOFT_STATE_CONFLICT,
  type SoftStateConflictPort,
} from './soft-state-conflict';
import type { ZmScope } from './zm-schedule-query.service';

/** One side of a move, as the design's capacity bar reads it: `5/6 → 6/6`. */
export interface OverrideLaneImpact {
  seId: string;
  seName: string | null;
  /** What this engineer carries now — `committedDayPlan`, the definition the engine enforces against. */
  committed: number;
  /** Where the move would leave them. Arithmetic over the proposal; nothing is written to find it. */
  after: number;
  /** Null when the engineer has no cap set — no denominator, and no overload marking either. */
  dailyCapacity: number | null;
  /** `after >= dailyCapacity`, matching the recommender's own `OVER_CAPACITY` boundary. */
  overCapacity: boolean;
}

/**
 * Where the run that placed this ticket ranked the *target* engineer — the design's "System view:
 * Sneha ranked #2 for this ticket in the 05:00 run".
 *
 * Null when there is nothing to say: the ticket was placed by hand, or its run predates the trace, or
 * the target was not in the candidate pool at all. **Null is "unknown", never "unranked"** — the same
 * rule #283's provenance follows, and for the same reason: a fabricated rank would be read as the
 * engine's opinion.
 */
export interface OverrideRankContext {
  ticketId: string;
  runId: string;
  /** The engine's processing order for this ticket in that run. */
  processingRank: number | null;
  /** Who the run actually chose. */
  chosenSeId: string | null;
  /** The target's precedence rank among the candidates the run compared, when it saw them at all. */
  targetPrecedenceRank: number | null;
  /** `PASSED` / `DROPPED` / `TIER_NOT_REACHED` as the run recorded it for the target. */
  targetVerdict: string | null;
  /** Why the run dropped the target, when it did. */
  targetDropReason: string | null;
}

/** What the move does to the target's route. Appended — never a reorder (#258 Q6's ordinal plan). */
export interface OverrideRouteImpact {
  /** The target's live schedule for the day, or null when the move would open their first one. */
  targetScheduleId: string | null;
  /** The stop the work lands on: an existing stop for this plant, or the next one appended. */
  appendedAsStop: number;
  /** True when the target already stops at this plant today, so nothing new appears on their route. */
  joinsExistingStop: boolean;
  /**
   * Always `false`, and stated rather than assumed. `moveTickets` appends — it never renumbers the
   * target's existing stops — and the design promises the operator exactly that ("her route is not
   * reordered"). A projection that merely omitted the question would leave the promise unverifiable.
   */
  reordersExistingStops: false;
}

export interface OverrideConflicts {
  /** Tickets the SE is ON_SITE on — the existing `CONFLICT_ON_SITE` gate, surfaced before the write. */
  onSite: string[];
  /** Tickets held to a future return date — the existing `CONFLICT_DEFERRED` gate (#249). */
  deferred: string[];
}

export type OverrideImpact =
  | {
      result: 'OK';
      action: 'REASSIGN' | 'SWAP_SE' | 'SPLIT_BATCH';
      batchId: string;
      plantId: string;
      plantName: string;
      ticketIds: string[];
      from: OverrideLaneImpact;
      to: OverrideLaneImpact;
      rank: OverrideRankContext | null;
      route: OverrideRouteImpact;
      conflicts: OverrideConflicts;
    }
  | { result: 'NOT_FOUND' }
  /** The action moves no work between engineers, so "both lanes' capacity" has no meaning for it. */
  | { result: 'NOT_PROJECTABLE'; action: OverrideCommand['action'] };

/** The three override actions that hand work to a *different* engineer — the ones with two lanes. */
const PROJECTABLE = new Set(['REASSIGN', 'SWAP_SE', 'SPLIT_BATCH']);

/**
 * #289 — what a proposed override would do, before it is done.
 *
 * The approved flow is **inspect → understand → override → preview impact → confirm** (#282 R1, the
 * design's step 3). The system had every step but this one: `OverrideService` commits immediately, so
 * the only way to see a move's effect was to make it.
 *
 * **This service writes nothing, and that is its whole contract.** There is no `create`, no `update`,
 * no `$transaction` and no `$executeRaw` in this file — the same posture
 * `DistributeProjectionService` (#276) holds and #250's dry run proved. It takes no advisory lock, no
 * in-flight slot and opens no `dispatch_runs` row either: a preview an operator opens during a live
 * dispatch must cost that dispatch nothing.
 *
 * **It re-derives nothing either.** Capacity comes from `committedDayPlan` (#269 / #272 R9, the one
 * definition the engine itself enforces against), the conflicts are read with the same predicates
 * `OverrideService.override` gates on, and the route effect mirrors what `moveTickets` actually does.
 * A preview computed a second way is a preview that will eventually disagree with the commit it
 * precedes — which is worse than no preview, because the operator would have trusted it.
 */
@Injectable()
export class OverrideProjectionService {
  /**
   * #311 (CB-4) — the SAME conflict source the commit gates on, injected rather than assumed absent.
   *
   * `@Optional()` and the `NoConflictSoftStatePort` fallback mirror {@link OverrideService} exactly,
   * because the two must not be able to answer differently: if one falls back and the other does not,
   * the drift this slice closes reopens in the shape of a hand-constructed instance. That cuts both
   * ways and is the forensic A6 note — a fixture that omits the port asserts the seam's silence, not
   * this behaviour, so any spec pinning the parity has to bind the real adapter to BOTH.
   */
  private readonly conflict: SoftStateConflictPort;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(SOFT_STATE_CONFLICT) conflict?: SoftStateConflictPort,
  ) {
    this.conflict = conflict ?? new NoConflictSoftStatePort();
  }

  async projectOverride(
    batchId: bigint,
    cmd: OverrideCommand,
    scope: ZmScope,
    now: Date = new Date(),
  ): Promise<OverrideImpact> {
    if (!PROJECTABLE.has(cmd.action)) return { result: 'NOT_PROJECTABLE', action: cmd.action };
    const newSeId = 'newSeId' in cmd ? cmd.newSeId : null;
    if (newSeId === null) return { result: 'NOT_PROJECTABLE', action: cmd.action };

    const batch = await this.prisma.plantBatchAssignment.findUnique({
      where: { batchId },
      include: { schedule: true, plant: { select: { name: true } } },
    });
    // Same clamp as the write, so a preview can never answer for a batch the confirm would refuse.
    if (!batch || !this.inScope(batch.schedule.zoneId, scope)) return { result: 'NOT_FOUND' };

    const target = await this.prisma.engineerMaster.findUnique({
      where: { engineerId: newSeId },
      include: { user: { select: { name: true } } },
    });
    if (!target) return { result: 'NOT_FOUND' };

    const ticketIds = await this.movingTicketIds(batch.batchId, cmd);
    if (ticketIds.length === 0) return { result: 'NOT_FOUND' };

    const day = istDate(now);
    const source = await this.prisma.engineerMaster.findUnique({
      where: { engineerId: batch.seId },
      include: { user: { select: { name: true } } },
    });
    const load = await committedDayPlan(this.prisma, day, { seIds: [batch.seId, newSeId] });
    const fromCommitted = load.get(batch.seId)?.count ?? 0;
    const toCommitted = load.get(newSeId)?.count ?? 0;
    const n = ticketIds.length;

    const [rank, route, conflicts] = await Promise.all([
      this.rankContext(batch.runId ?? batch.schedule.runId, ticketIds, newSeId),
      this.routeImpact(newSeId, batch.plantId, batch.schedule, day),
      this.conflictsFor(ticketIds, day),
    ]);

    return {
      result: 'OK',
      action: cmd.action as 'REASSIGN' | 'SWAP_SE' | 'SPLIT_BATCH',
      batchId: String(batch.batchId),
      plantId: String(batch.plantId),
      plantName: batch.plant?.name ?? String(batch.plantId),
      ticketIds,
      from: this.lane(batch.seId, source?.user?.name ?? null, source?.dailyCapacity ?? null, fromCommitted, -n),
      to: this.lane(newSeId, target.user?.name ?? null, target.dailyCapacity ?? null, toCommitted, +n),
      rank,
      route,
      conflicts,
    };
  }

  /**
   * One side of the capacity bar. `after` is clamped at zero: a source whose committed count is
   * smaller than the set being moved means the two reads disagree (a concurrent write between them),
   * and showing a negative day would be a worse answer than showing an empty one.
   */
  private lane(
    seId: string,
    seName: string | null,
    dailyCapacity: number | null,
    committed: number,
    delta: number,
  ): OverrideLaneImpact {
    const after = Math.max(0, committed + delta);
    return {
      seId,
      seName,
      committed,
      after,
      dailyCapacity,
      // `>=`, the recommender's own `OVER_CAPACITY` boundary — a lane showing room at exactly 10/10
      // would disagree with the engine it is previewing against. Stated, never a refusal (#258 Q2).
      overCapacity: dailyCapacity !== null && dailyCapacity > 0 && after >= dailyCapacity,
    };
  }

  /** Exactly the tickets this command would move — the same rule `affectedTicketIds` applies. */
  private async movingTicketIds(batchId: bigint, cmd: OverrideCommand): Promise<string[]> {
    if (cmd.action === 'REASSIGN') return [cmd.ticketId];
    if (cmd.action === 'SPLIT_BATCH') return cmd.ticketIds;
    const rows = await this.prisma.batchAssignmentTicket.findMany({
      where: { batchId, removedAt: null },
      select: { ticketId: true },
    });
    return rows.map((r) => r.ticketId);
  }

  /**
   * "Where did the run rank the engineer you are about to give this to?"
   *
   * Read from the run's own `dispatch_decision_traces` row — the engine's record, not a re-scoring.
   * For a multi-ticket move the first ticket's trace is used: the panel states one sentence and a
   * per-ticket rank list is a different feature (the Replay stream, #284 §C, already lists all of them
   * and this links to it).
   */
  private async rankContext(
    runId: bigint | null,
    ticketIds: string[],
    targetSeId: string,
  ): Promise<OverrideRankContext | null> {
    if (runId === null || ticketIds.length === 0) return null;
    const trace = await this.prisma.dispatchDecisionTrace.findFirst({
      where: { runId, ticketId: ticketIds[0] },
      include: { recommendation: { select: { processingRank: true } } },
    });
    if (!trace) return null;
    const json = (trace.trace as Record<string, unknown>) ?? {};
    const chosen = json.chosen as { seId?: string } | null;
    const runnersUp = (json.runnersUp as Array<Record<string, unknown>> | undefined) ?? [];
    const mine = runnersUp.find((r) => r.seId === targetSeId);
    return {
      ticketId: trace.ticketId,
      runId: String(runId),
      processingRank: trace.recommendation?.processingRank ?? null,
      chosenSeId: chosen?.seId ?? null,
      targetPrecedenceRank:
        chosen?.seId === targetSeId ? 1 : typeof mine?.precedenceRank === 'number' ? mine.precedenceRank : null,
      targetVerdict: chosen?.seId === targetSeId ? 'CHOSEN' : typeof mine?.verdict === 'string' ? mine.verdict : null,
      targetDropReason: typeof mine?.dropReason === 'string' ? mine.dropReason : null,
    };
  }

  /**
   * What the target's route looks like afterwards, derived the way `moveTickets` actually behaves: it
   * reuses an existing (schedule, plant) batch when there is one and otherwise appends a new stop at
   * `max(stop_sequence) + 1`. Existing stops are never renumbered.
   */
  private async routeImpact(
    targetSeId: string,
    plantId: bigint,
    schedule: { dateFrom: Date; dateTo: Date; zoneId: bigint },
    day: Date,
  ): Promise<OverrideRouteImpact> {
    const sched = await this.prisma.workSchedule.findFirst({
      where: {
        seId: targetSeId,
        zoneId: schedule.zoneId,
        dateFrom: { lte: day },
        dateTo: { gte: day },
        status: { in: ['ACTIVE', 'OVERRIDDEN'] },
      },
      orderBy: { scheduleId: 'asc' },
    });
    if (!sched) {
      // No live plan today: the move opens one, and this work is its first stop.
      return { targetScheduleId: null, appendedAsStop: 1, joinsExistingStop: false, reordersExistingStops: false };
    }
    const existing = await this.prisma.plantBatchAssignment.findFirst({
      where: { scheduleId: sched.scheduleId, plantId, seId: targetSeId },
      select: { stopSequence: true },
    });
    if (existing) {
      return {
        targetScheduleId: String(sched.scheduleId),
        appendedAsStop: existing.stopSequence,
        joinsExistingStop: true,
        reordersExistingStops: false,
      };
    }
    const last = await this.prisma.plantBatchAssignment.aggregate({
      where: { scheduleId: sched.scheduleId },
      _max: { stopSequence: true },
    });
    return {
      targetScheduleId: String(sched.scheduleId),
      appendedAsStop: (last._max.stopSequence ?? 0) + 1,
      joinsExistingStop: false,
      reordersExistingStops: false,
    };
  }

  /**
   * The two gates the confirm will apply, read ahead of it.
   *
   * Deliberately **reported, not enforced**: both are confirm-and-reason gates on the write, not
   * refusals, so a preview that hid a conflicted move would be lying about what the operator is
   * allowed to do.
   *
   * #311 (CB-4) — `onSite` used to be hardcoded `[]` with a note that `soft_states` "does not exist
   * yet". It did: the adapter was implemented, bound in this very module, and the commit path was
   * already gating on it. So the preview reported a clean move for a batch whose engineer was standing
   * at the plant, and the identical confirm body came back `CONFLICT_ON_SITE` — the drift this file's
   * own header calls worse than no preview, arriving through a comment that had simply outlived its
   * premise. It now asks {@link SoftStateConflictPort}, which is the same object the commit consults,
   * so the two agree **by construction** rather than by two predicates being kept in step.
   *
   * Asking the port rather than reading `soft_states` here is the load-bearing half: VIEWED and
   * resolved states do not count, and a second copy of that rule would be a second thing to drift.
   */
  private async conflictsFor(ticketIds: string[], day: Date): Promise<OverrideConflicts> {
    const held = await this.prisma.ticket.findMany({
      where: { ticketId: { in: ticketIds }, deferredUntil: { gt: day } },
      select: { ticketId: true },
    });
    const onSite = await this.conflict.activeOnSiteTicketIds(ticketIds);
    return { onSite: [...onSite], deferred: held.map((t) => t.ticketId) };
  }

  private inScope(zoneId: bigint, scope: ZmScope): boolean {
    if (scope.role === 'ZONAL_MANAGER') return scope.zoneId != null && BigInt(scope.zoneId) === zoneId;
    return true; // CSM / Operations Head — cross-zone
  }
}
