import { Inject, Injectable, Optional } from '@nestjs/common';
import { istDate, istWindowStart } from '../common/ist-day';
import { LostRaceError, isDeadlock, stampOnceOrLose } from '../common/lost-race';
import { isUniqueViolationOn, retryOnceOnUniqueViolation } from '../common/unique-violation';
import { Prisma } from '../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { assignableTickets } from '../ticketing/assignable-work';
import { isNotDeferredOn, notDeferredOn } from '../ticketing/deferral';
import { ADD_SOURCES, addProvenanceSourceFor, type CoverageAtAssign } from './add-source';
import { resolveCoverageAtAssign, resolveCoverageForPlants } from './coverage-at-assign';
import { DAY_PLAN_NOTIFIER, DayPlanNotifier } from './day-plan-notifier';
import { drainRows, queueDayPlanOverridden } from './day-plan-notification-outbox';
import { REMOVAL_REASONS } from './removal-reason';
import { liveScheduleFilter } from './schedule-status';
import {
  NoConflictSoftStatePort,
  SOFT_STATE_CONFLICT,
  type SoftStateConflictPort,
} from './soft-state-conflict';
import { ZmScope } from './zm-schedule-query.service';

export interface ActorContext {
  userId: string;
  role: string;
  actedAsRole?: string | null;
  /**
   * The zone whose ZM duty this write is being made under, when the caller is acting (#340).
   * Attribution, not scope: it names who was covering, never what the caller may touch.
   */
  actingZone?: number | null;
}

export type OverrideCommand =
  | { action: 'REMOVE_TICKET'; ticketId: string; reasonCode: string; confirm?: boolean }
  | { action: 'DEFER_TICKET'; ticketId: string; deferredToDate: string; reasonCode: string; confirm?: boolean }
  | { action: 'REORDER'; stopSequence: number; reasonCode: string; confirm?: boolean }
  | { action: 'SWAP_SE'; newSeId: string; reasonCode: string; confirm?: boolean }
  | { action: 'REASSIGN'; ticketId: string; newSeId: string; reasonCode: string; confirm?: boolean }
  | { action: 'SPLIT_BATCH'; ticketIds: string[]; newSeId: string; reasonCode: string; confirm?: boolean }
  /**
   * **Move one ticket's planned assignment to another operating day** — the Console's cross-day drag.
   *
   * The action `DEFER_TICKET` was standing in for and should never have been: a defer *unassigns*
   * (`assignment_state → UNASSIGNED` + `deferred_until`) and hands the question of who does the work
   * back to the run that will decide on that date. This **keeps the assignment** and relocates it —
   * same ticket, same `FORMALLY_ASSIGNED` state, a `work_schedules` row for `targetDate` instead of
   * today's. The operator's gesture said "this engineer, that day"; only this answers it.
   *
   * `newSeId` is required and may be the ticket's current engineer — moving a day and moving an
   * engineer are one operation here, because the drop names both coordinates at once and refusing the
   * diagonal would mean two dialogs for one gesture.
   */
  | {
      action: 'MOVE_TICKET';
      ticketId: string;
      newSeId: string;
      /** IST operating day, `YYYY-MM-DD`. Never in the past — see `TARGET_DATE_IN_PAST`. */
      targetDate: string;
      reasonCode: string;
      confirm?: boolean;
    };

/**
 * A caller's write that belongs to the same transaction as the assignment it describes — #325.
 * Receives only the ids this assignment minted, so it can complete the record and nothing else.
 */
export type AssignInTransaction = (
  tx: Prisma.TransactionClient,
  ids: { scheduleId: bigint; batchId: bigint },
) => Promise<void>;

export type OverrideOutcome =
  | {
      result: 'OK';
      batchId: string;
      scheduleId: string;
      seId: string;
      status: string;
      /**
       * The operating day the work now sits on — present only for `MOVE_TICKET`, absent for every
       * other action, whose answer is about today by construction. Optional rather than always-present
       * so no existing response shape changes by a single field.
       */
      movedToDate?: string;
    }
  | { result: 'NOT_FOUND' }
  | { result: 'CONFLICT_ON_SITE'; ticketIds: string[]; seId: string }
  /** #249 — one or more moved tickets carry a future return-date deferral; resend with `confirm`. */
  | { result: 'CONFLICT_DEFERRED'; ticketIds: string[]; seId: string }
  /**
   * A `MOVE_TICKET` naming a day that has already been. Refused rather than clamped: a past day's
   * plan is history the SE has already executed or failed to, and writing new work onto it would
   * fabricate a decision nobody made. Today is legal — that is an ordinary same-day reassignment.
   */
  | { result: 'TARGET_DATE_IN_PAST'; targetDate: string; today: string }
  /**
   * The command names an action this build does not implement — in practice, an admin bundle
   * deployed ahead of the API. A refusal that says so, rather than the 500 an unhandled fall-through
   * produced, or the `NOT_FOUND` that blames the batch.
   */
  | { result: 'UNSUPPORTED_ACTION'; action: string }
  /**
   * #310 (RC-11) — a date that would do nothing. Distinct from `TARGET_DATE_IN_PAST`, and the two are
   * not one member wearing two names: a `MOVE_TICKET` onto **today** is an ordinary same-day
   * reassignment, while a `DEFER_TICKET` to today is not a deferral at all. `notDeferredOn` is
   * inclusive, so `deferred_until = today` is dispatchable today: the ticket leaves the batch, the
   * audit row says DEFER, and the very next run re-plans it. That is a bare remove under the wrong
   * name — the one outcome an operator cannot see and cannot undo.
   *
   * Carries the field so the 400 can name what to fix, and `today` so the client can say why.
   */
  | { result: 'INVALID_DATE'; field: 'deferredToDate'; value: string; today: string };

/** Override actions that create work for a *different* SE, and so must not move a held ticket blind. */
const MOVE_ACTIONS: ReadonlySet<OverrideCommand['action']> = new Set([
  'SWAP_SE',
  'REASSIGN',
  'SPLIT_BATCH',
  // A cross-day move creates an assignment on another day, so it belongs to the same gate: carrying a
  // held ticket onto a future plan without somebody saying so is the identical mistake, one day later.
  'MOVE_TICKET',
]);

/**
 * Which `add_source` each mover stamps on the destination row. One table rather than a conditional at
 * the write, so adding a mover cannot silently inherit another one's provenance — which is exactly
 * what a third branch on `action === 'SPLIT_BATCH' ? … : …` would have done for `MOVE_TICKET`.
 */
const MOVE_ADD_SOURCE: Readonly<Record<string, (typeof ADD_SOURCES)[keyof typeof ADD_SOURCES]>> = {
  REASSIGN: ADD_SOURCES.MANUAL_REASSIGN,
  SPLIT_BATCH: ADD_SOURCES.MANUAL_SPLIT,
  MOVE_TICKET: ADD_SOURCES.MANUAL_DAY_MOVE,
};

/**
 * The vehicle wait behind a deferral, when there is one (#249). Carried on the refusal so the confirm
 * dialog can state *why* the ticket is held rather than only *until when* — and can show the pair
 * #245 separated, since an override may have moved the authoritative date away from what the SE
 * reported. A ZM deferral has no report; the field is then null and the date stands alone.
 */
export interface DeferralVuContext {
  id: string;
  proposedFrom: string;
  expectedFrom: string;
}

export type AssignOutcome =
  | { result: 'OK'; scheduleId: string; batchId: string; ticketId: string; seId: string }
  | { result: 'NOT_FOUND' }
  | { result: 'ALREADY_ASSIGNED' }
  /** #249 — the ticket is held to a future return date; resend with `confirm` + a reason. */
  | { result: 'CONFLICT_DEFERRED'; ticketId: string; deferredUntil: string; vuReport: DeferralVuContext | null }
  /** #249 — confirmed, but with no reason. An override with no stated why is not an override. */
  | { result: 'REASON_REQUIRED' };

/** #249 — a caller's explicit decision to override a return-date deferral. */
export interface DeferralOverrideInput {
  confirm?: boolean;
  reasonCode?: string;
}

/** Result of the multi-plant manual assign (Issue 122b): per-plant tallies + the overall totals. */
export interface PlantAssignSummary {
  seId: string;
  assigned: number;
  alreadyAssigned: number;
  perPlant: { plantId: string; assigned: number; openUnassigned: number }[];
}

/** One (engineer, tickets) unit of an `assign-batch` commit (#275). */
export interface AssignBatchLane {
  seId: string;
  ticketIds: string[];
}

/** Why a ticket in a lane was not written — reported per ticket, never folded into a bare count. */
export type AssignBatchSkipReason = 'NOT_FOUND' | 'OUT_OF_ZONE' | 'CONFLICT_DEFERRED' | 'LOST_RACE';

/**
 * One lane's outcome. `assigned`/`alreadyAssigned` are counts (matching {@link PlantAssignSummary}'s
 * vocabulary); `skipped` is itemised because a bare count cannot tell an operator *which* ticket needs
 * a second look (#275 required-change #1). `batchIds` is plural — the issue text names a singular
 * `batchId`, but a lane routinely spans more than one plant (every console lane can), and each plant is
 * its own `plant_batch_assignments` row; collapsing that to one id would be wrong on the common case,
 * not just the edge case.
 */
export interface AssignBatchLaneResult {
  seId: string;
  result: 'OK' | 'SE_NOT_FOUND' | 'LANE_FAILED';
  assigned: number;
  alreadyAssigned: number;
  skipped: { ticketId: string; reason: AssignBatchSkipReason }[];
  scheduleId?: string;
  batchIds: string[];
}

export interface AssignBatchResult {
  lanes: AssignBatchLaneResult[];
}

/**
 * Ticket-itemised shape {@link assignBatch} and the {@link OverrideService.assignPlants} shorthand
 * both build on — the one place lane semantics live, so the two public shapes cannot drift apart.
 */
type LaneDetail =
  | { seId: string; ok: false; reason: 'SE_NOT_FOUND' }
  | {
      seId: string;
      ok: true;
      assignedTicketIds: string[];
      assignedPlantIds: Map<string, bigint>;
      alreadyAssignedTicketIds: string[];
      skipped: { ticketId: string; reason: AssignBatchSkipReason }[];
      scheduleId: bigint | undefined;
      batchIds: bigint[];
    };

type BatchWithSchedule = Prisma.PlantBatchAssignmentGetPayload<{ include: { schedule: true } }>;

/**
 * **The row acquisition order every write in this file follows** (#327, forensics RC-12/RC-13):
 *
 * ```
 *   tickets  →  work_schedules  →  plant_batch_assignments  →  batch_assignment_tickets
 * ```
 *
 * Two doors assign the same ticket — {@link OverrideService.assignTicket} (one click, one ticket) and
 * {@link OverrideService.assignLane} (the Console's Assign draft, one transaction per engineer) — and
 * they grew independently. The lane locked the ticket row and *then* inserted the batch-ticket row;
 * the one-click door inserted the batch-ticket row and *then* updated the ticket. Each therefore held
 * the row the other needed next, and Postgres broke the cycle the only way it can: a 40P01 that
 * reached one operator as a 500 and the other as a lane that failed for no stated reason.
 *
 * **The lane's order is the one both now use**, for three reasons. It is the order the dispatch run
 * already writes in (`batch-assignment.service.ts` — "#306: the ticket write comes FIRST, and it is
 * guarded"). The ticket row is the row every path actually contends on, so taking it first is what
 * makes a loser leave nothing behind. And aligning the *lane* to the one-click door instead would have
 * meant unwinding the `FOR UPDATE ... SKIP LOCKED` re-verify #265 put there — the one guard standing
 * between a multi-ticket lane and a P2002 that aborts every sibling written in it.
 *
 * The stop-number mints obey the same order one level down: {@link OverrideService.nextStopSequence}
 * and both renumbering paths take the schedule row before touching any batch under it, so `max + 1`
 * is computed by one writer at a time (RC-13) and two renumbers cannot walk the same batches in
 * opposite directions. See {@link OverrideService.lockSchedule}.
 *
 * **#334 brought the last two writers onto this order**, and recorded the one decision it turned on
 * here rather than in either file, because this block is where the order is stated:
 *
 * - **The dispatch run moved, not the manual doors.** `batch-assignment.service.ts` took the SE's
 *   schedule before its guarded ticket write, which inverts the pair above and cycles with any manual
 *   assign holding the ticket row. It now writes the tickets first. The alternative — realigning both
 *   doors to schedule-first — would have unwound the three reasons #327 chose this order in the first
 *   place, to fix a file that had never stated an order at all.
 * - **A transaction touching two schedules takes them ascending by id.** The movers had no order
 *   between source and destination, so two moves in opposite directions between one pair of engineers
 *   each held the row the other needed next. See {@link OverrideService.lockSchedulesInOrder}.
 *
 * A residual 40P01 — from a writer this file does not own — is still mapped to each door's existing
 * conflict outcome rather than left to surface as a 500. See `isDeadlock` in `common/lost-race.ts`;
 * it is the backstop, and #334 is about not needing it.
 */
/**
 * The ZM Batch override engine (Issue 13a, LLD §5.4/§12.4). Each action commits immediately, flips
 * the batch + its schedule to OVERRIDDEN with the mandatory reason and overrider, re-points the SE
 * Day Plan, audits in-transaction, and fires a push. No approval gate. Override of work an SE holds
 * ON_SITE on is gated by the conflict seam (slice 5). Invokable from the batches controller.
 */
@Injectable()
export class OverrideService {
  private readonly conflict: SoftStateConflictPort;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(DAY_PLAN_NOTIFIER) private readonly notifier: DayPlanNotifier,
    @Optional() @Inject(SOFT_STATE_CONFLICT) conflict?: SoftStateConflictPort,
  ) {
    this.conflict = conflict ?? new NoConflictSoftStatePort();
  }

  async override(
    batchId: bigint,
    cmd: OverrideCommand,
    scope: ZmScope,
    actor: ActorContext,
    now: Date = new Date(),
    /** When set (Issue 31 same-day update), the change audits under this action (e.g. `MANUAL_ZM_UPDATE`)
     *  with an `updateType` in metadata, so it surfaces in the Intra-day Queue instead of as a plain
     *  `BATCH_OVERRIDE_*` morning-batch override. Only REMOVE_TICKET / REORDER honour it. */
    auditAction?: string,
  ): Promise<OverrideOutcome> {
    const batch = await this.prisma.plantBatchAssignment.findUnique({
      where: { batchId },
      include: { schedule: true },
    });
    if (!batch || !this.inScope(batch.schedule.zoneId, scope)) return { result: 'NOT_FOUND' };

    // ON_SITE conflict gate (LLD §12.4): an override touching work an SE holds ON_SITE on needs an
    // explicit confirm + reason; the held ON_SITE is never silently cleared. Seam until Issue 15.
    const affected = await this.affectedTicketIds(batch, cmd);
    const onSite = await this.conflict.activeOnSiteTicketIds(affected);
    if (onSite.size > 0) {
      if (!cmd.confirm) {
        return { result: 'CONFLICT_ON_SITE', ticketIds: [...onSite], seId: batch.seId };
      }
      await this.prisma.auditLog.create({
        data: {
          actorId: actor.userId,
          actorRole: actor.role,
          actedAsRole: actor.actedAsRole ?? null,
          actingZone: actor.actingZone != null ? BigInt(actor.actingZone) : null,
          action: 'OVERRIDE_AFTER_ON_SITE',
          entityType: 'plant_batch_assignment',
          entityId: String(batch.batchId),
          metadata: { action: cmd.action, ticketIds: [...onSite], reasonCode: cmd.reasonCode } as Prisma.InputJsonValue,
        },
      });
    }

    // #249 AC4, defence in depth — a move must not carry a held ticket onto another SE's plan without
    // somebody saying so. Structurally this is near-vacuous (a deferred ticket has no live batch row to
    // move) and is reachable only through the verified edge #249 also closes: an `assignTicket` that
    // left a future `deferred_until` standing on assigned work. It is gated anyway, because "you can
    // only get here through a bug we just fixed" is not a guarantee.
    //
    // REMOVE / DEFER / REORDER are deliberately outside the gate: none of them creates an assignment,
    // and refusing to *withdraw* or re-order a held ticket would obstruct the very actions that respect
    // the hold. The deferral is preserved on a confirmed move — only an assignment spends one.
    if (MOVE_ACTIONS.has(cmd.action)) {
      const heldIds = await this.deferredTicketIds(affected, istDate(now));
      if (heldIds.length > 0) {
        if (!cmd.confirm) return { result: 'CONFLICT_DEFERRED', ticketIds: heldIds, seId: batch.seId };
        await this.prisma.auditLog.create({
          data: {
            actorId: actor.userId,
            actorRole: actor.role,
            actedAsRole: actor.actedAsRole ?? null,
            actingZone: actor.actingZone != null ? BigInt(actor.actingZone) : null,
            action: 'OVERRIDE_DEFERRED_MOVE',
            entityType: 'plant_batch_assignment',
            entityId: String(batch.batchId),
            metadata: { action: cmd.action, ticketIds: heldIds, reasonCode: cmd.reasonCode } as Prisma.InputJsonValue,
          },
        });
      }
    }

    try {
      return await this.applyCommand(batch, cmd, actor, now, auditAction);
    } catch (e: unknown) {
      // #327 — a residual 40P01. Every write in this file now takes its rows in one order (see the
      // acquisition-order note above the class), but a cross-schedule move has no natural order
      // between its source and its destination, and nothing here can order a writer this file does not
      // own. `NOT_FOUND` is the outcome the guarded writes in this same door already answer a lost race
      // with — "the row you asked me to act on is no longer yours to act on" — and reusing it keeps the
      // API shape unchanged, which is what an operator retrying the click needs anyway. The transaction
      // rolled back whole, so nothing is half-applied behind the refusal.
      if (isDeadlock(e)) return { result: 'NOT_FOUND' };
      throw e;
    }
  }

  /** The command switch itself, so {@link override}'s gates run exactly once around it. */
  private async applyCommand(
    batch: BatchWithSchedule,
    cmd: OverrideCommand,
    actor: ActorContext,
    now: Date,
    auditAction?: string,
  ): Promise<OverrideOutcome> {
    switch (cmd.action) {
      case 'REMOVE_TICKET':
        return this.removeTicket(batch.batchId, batch.scheduleId, batch.seId, cmd, actor, now, auditAction);
      case 'DEFER_TICKET': {
        // The day-axis validation, in the same place `MOVE_TICKET`'s lives (below) and for the same
        // reason: it is a question about the operating day, so it belongs beside the action that asks
        // it, after scope — an out-of-zone batch stays a 404 and learns nothing from the refusal.
        //
        // Strictly future, where a move allows today. `istWindowStart` is the repo's one parser for a
        // bare `YYYY-MM-DD` and returns Invalid Date for a day that does not exist (`2026-02-31`)
        // rather than rolling it over into March.
        const today = istDate(now);
        const returnDay = istDate(istWindowStart(cmd.deferredToDate));
        if (Number.isNaN(returnDay.getTime()) || returnDay.getTime() <= today.getTime()) {
          return {
            result: 'INVALID_DATE',
            field: 'deferredToDate',
            value: cmd.deferredToDate,
            today: today.toISOString().slice(0, 10),
          };
        }
        return this.deferTicket(batch.batchId, batch.scheduleId, batch.seId, cmd, actor, now);
      }
      case 'REORDER':
        return this.reorder(batch.batchId, batch.scheduleId, batch.seId, cmd, actor, now, auditAction);
      case 'SWAP_SE':
        return this.swapSe(batch, cmd, actor, now);
      case 'REASSIGN':
        return this.moveTickets(batch, [cmd.ticketId], cmd.newSeId, cmd.action, cmd.reasonCode, actor, now);
      case 'SPLIT_BATCH':
        return this.moveTickets(batch, cmd.ticketIds, cmd.newSeId, cmd.action, cmd.reasonCode, actor, now);
      case 'MOVE_TICKET': {
        // The one validation the day axis adds. Everything else a move needs — scope, the ON_SITE
        // gate, the deferral gate — has already run above and applies unchanged.
        const targetDay = istDate(new Date(`${cmd.targetDate}T00:00:00.000Z`));
        const today = istDate(now);
        if (Number.isNaN(targetDay.getTime()) || targetDay.getTime() < today.getTime()) {
          return {
            result: 'TARGET_DATE_IN_PAST',
            targetDate: cmd.targetDate,
            today: today.toISOString().slice(0, 10),
          };
        }
        return this.moveTickets(batch, [cmd.ticketId], cmd.newSeId, cmd.action, cmd.reasonCode, actor, now, targetDay);
      }
      default:
        // `NOT_FOUND` used to be the answer here, and it named the wrong thing: the batch is fine,
        // the verb is not. A client told "batch not found" about a batch it is looking at will go
        // hunting for a data problem that does not exist.
        return { result: 'UNSUPPORTED_ACTION', action: String((cmd as { action?: unknown }).action ?? '') };
    }
  }

  private async removeTicket(
    batchId: bigint,
    scheduleId: bigint,
    seId: string,
    cmd: Extract<OverrideCommand, { action: 'REMOVE_TICKET' }>,
    actor: ActorContext,
    now: Date,
    auditAction?: string,
  ): Promise<OverrideOutcome> {
    const bat = await this.prisma.batchAssignmentTicket.findFirst({
      where: { batchId, ticketId: cmd.ticketId, removedAt: null },
    });
    if (!bat) return { result: 'NOT_FOUND' };

    let outboxId: bigint;
    try {
      outboxId = await this.audit.withAudit(
        this.auditEntry(actor, batchId, {
          action: cmd.action,
          ticketId: cmd.ticketId,
          reasonCode: cmd.reasonCode,
          seId,
        }, auditAction),
        async (tx) => {
          // #265 — `removedAt: null` back in the WHERE. The read above happened outside this
          // transaction, so a concurrent remover — or the 04:00 closure recycle, which guards its own
          // writes for precisely this reason — can commit in between; an update keyed only on `id`
          // would then overwrite their actor and reason with ours. #244 reads `removal_reason` as a
          // predicate, so that is an operational reclassification, not a visible error. Losing throws
          // so the transaction rolls back **including the audit row**: nothing may record a withdrawal
          // that did not happen.
          await stampOnceOrLose(
            tx.batchAssignmentTicket,
            { id: bat.id, removedAt: null },
            {
              removedAt: now,
              removedBy: actor.userId,
              removalReason: REMOVAL_REASONS.ZM_WITHDRAWN,
              // The sentence beside the predicate. This door mandates a reason and used to publish
              // none — see the `removal_note` migration for why it cannot live on `removalReason`.
              removalNote: cmd.reasonCode,
            },
            'REMOVE_TICKET',
          );
          // Returned to the Shared Pool — no longer a Formal Assignment.
          await tx.ticket.update({ where: { ticketId: cmd.ticketId }, data: { assignmentState: 'UNASSIGNED' } });
          await this.flagOverridden(tx, batchId, scheduleId, cmd.reasonCode, actor, now);
          // #264 — written inside this same transaction: a withdrawal that rolls back leaves no ghost
          // "Day Plan updated" outbox row.
          return queueDayPlanOverridden(tx, { seId, scheduleId, batchId, action: cmd.action });
        },
      );
    } catch (e: unknown) {
      // The row is already terminal — the same answer the pre-read would have given a moment later.
      if (e instanceof LostRaceError) return { result: 'NOT_FOUND' };
      throw e;
    }

    await drainRows(this.prisma, this.notifier, [outboxId], now);
    return { result: 'OK', batchId: String(batchId), scheduleId: String(scheduleId), seId, status: 'OVERRIDDEN' };
  }

  private async deferTicket(
    batchId: bigint,
    scheduleId: bigint,
    seId: string,
    cmd: Extract<OverrideCommand, { action: 'DEFER_TICKET' }>,
    actor: ActorContext,
    now: Date,
  ): Promise<OverrideOutcome> {
    const bat = await this.prisma.batchAssignmentTicket.findFirst({
      where: { batchId, ticketId: cmd.ticketId, removedAt: null },
    });
    if (!bat) return { result: 'NOT_FOUND' };

    let outboxId: bigint;
    try {
      outboxId = await this.audit.withAudit(
      this.auditEntry(actor, batchId, {
        action: cmd.action,
        ticketId: cmd.ticketId,
        deferredToDate: cmd.deferredToDate,
        reasonCode: cmd.reasonCode,
        seId,
      }),
      async (tx) => {
        // #146 B1 — the workflow defines defer as TWO clauses (`fsm-business-technical-workflow.md:711`):
        // "pushed to a specific future date" AND "removed from current batch". Only the first was
        // written, and `deferredToDate` had zero readers, so the ticket stayed on today's plan and kept
        // burning a capacity slot for a day it would not be worked. `removedAt` is the second clause:
        // every read already filters `removedAt: null`, so the day plan, the ZM schedule view, the
        // transparency reads and `committedDayLoad` all fall into line at once.
        //
        // #265 — guarded, for the same reason `removeTicket` is: the read above is outside this
        // transaction, so a concurrent remover or the closure recycle can make the row terminal in
        // between, and an update keyed only on `id` would overwrite their attribution with ours.
        await stampOnceOrLose(
          tx.batchAssignmentTicket,
          { id: bat.id, removedAt: null },
          {
            deferredToDate: new Date(cmd.deferredToDate),
            removedAt: now,
            removedBy: actor.userId,
            removalReason: REMOVAL_REASONS.ZM_DEFERRED,
            removalNote: cmd.reasonCode,
          },
          'DEFER_TICKET',
        );
        // Slice 3 — the second clause of the workflow's definition: "pushed to a specific future
        // date". The ticket returns to `UNASSIGNED` so it CAN be re-planned (leaving it
        // `FORMALLY_ASSIGNED` stranded it permanently — no reader of unassigned work could ever see
        // it again), and `deferredUntil` is what stops that re-planning happening today. The two are
        // a pair: every unassigned-work reader spreads in `notDeferredOn(day)`, so the ticket
        // reappears on the deferred date and not before. Splitting them would make defer a same-day
        // no-op with extra steps.
        await tx.ticket.update({
          where: { ticketId: cmd.ticketId },
          data: { assignmentState: 'UNASSIGNED', deferredUntil: new Date(cmd.deferredToDate) },
        });
        await this.flagOverridden(tx, batchId, scheduleId, cmd.reasonCode, actor, now);
        return queueDayPlanOverridden(tx, { seId, scheduleId, batchId, action: cmd.action });
      },
      );
    } catch (e: unknown) {
      if (e instanceof LostRaceError) return { result: 'NOT_FOUND' };
      throw e;
    }

    await drainRows(this.prisma, this.notifier, [outboxId], now);
    return { result: 'OK', batchId: String(batchId), scheduleId: String(scheduleId), seId, status: 'OVERRIDDEN' };
  }

  private async reorder(
    batchId: bigint,
    scheduleId: bigint,
    seId: string,
    cmd: Extract<OverrideCommand, { action: 'REORDER' }>,
    actor: ActorContext,
    now: Date,
    auditAction?: string,
  ): Promise<OverrideOutcome> {
    // Cheap refusal for a batch that is already gone, before an audited transaction is opened for it.
    // The plan this renumbers is re-read under the schedule lock below; this read decides nothing.
    if ((await this.prisma.plantBatchAssignment.count({ where: { batchId, scheduleId } })) === 0) {
      return { result: 'NOT_FOUND' };
    }

    let outboxId: bigint;
    try {
      outboxId = await this.audit.withAudit(
      this.auditEntry(actor, batchId, { action: cmd.action, stopSequence: cmd.stopSequence, reasonCode: cmd.reasonCode, seId }, auditAction),
      async (tx) => {
        // #327 (RC-13) — the plan is read under the schedule lock and renumbered in the same
        // transaction. It used to be read *before* the transaction opened, so a stop added in the gap
        // was never renumbered (two stops with one number, which is the very state this action exists
        // to heal) and a stop removed in the gap failed the whole reorder on a row that no longer
        // existed. The lock also gives two concurrent reorders one order to walk the batches in.
        //
        // One consequence, stated rather than hidden: the audit row above now records the position the
        // operator ASKED for instead of one clamped against a pre-transaction count. The clamp is a
        // function of the plan's length, which only the transaction can know, and the resulting order
        // is on the plan itself — so the trail is better off recording the request.
        await this.lockSchedule(tx, scheduleId);
        const batches = await tx.plantBatchAssignment.findMany({
          where: { scheduleId },
          orderBy: [{ stopSequence: 'asc' }, { batchId: 'asc' }],
        });
        const target = batches.find((b) => b.batchId === batchId);
        // Withdrawn while we waited for the lock — the same answer the pre-read would have given a
        // moment later, and a throw so the audit row rolls back with it (#265).
        if (!target) throw new LostRaceError('REORDER');

        // Insert the target at the requested 1-based position; the rest keep their relative order.
        const others = batches.filter((b) => b.batchId !== batchId);
        const pos = Math.max(1, Math.min(cmd.stopSequence, batches.length));
        const ordered = [...others];
        ordered.splice(pos - 1, 0, target);
        for (let i = 0; i < ordered.length; i++) {
          await tx.plantBatchAssignment.update({
            where: { batchId: ordered[i].batchId },
            data: { stopSequence: i + 1 },
          });
        }
        await this.flagOverridden(tx, batchId, scheduleId, cmd.reasonCode, actor, now);
        return queueDayPlanOverridden(tx, { seId, scheduleId, batchId, action: cmd.action });
      },
      );
    } catch (e: unknown) {
      if (e instanceof LostRaceError) return { result: 'NOT_FOUND' };
      throw e;
    }

    await drainRows(this.prisma, this.notifier, [outboxId], now);
    return { result: 'OK', batchId: String(batchId), scheduleId: String(scheduleId), seId, status: 'OVERRIDDEN' };
  }

  /**
   * Grouped Critical Work Queue one-click assign (AC#6). Creates a Formal Assignment for an OPEN,
   * not-yet-assigned ticket → SE: ensures the SE's same-day schedule + plant batch, adds the ticket,
   * and flips it FORMALLY_ASSIGNED (so it leaves the Shared Pool). A ZM-initiated manual scheduling
   * action — not an override of existing committed work.
   */
  async assignTicket(
    ticketId: string,
    seId: string,
    scope: ZmScope,
    actor: ActorContext,
    now: Date = new Date(),
    /**
     * Audit action stamped on the assignment row. Defaults to `CRITICAL_ASSIGN` (the Grouped Critical
     * Work Queue one-click). The ZM manual same-day ADD path (Issue 31) passes `MANUAL_ZM_UPDATE` so
     * the change surfaces in the Intra-day Queue view instead of as a system CRITICAL insertion.
     */
    auditAction = 'CRITICAL_ASSIGN',
    /**
     * When set (Issue 29 system CRITICAL insertion accept), the assigned batch is moved to the top of
     * the SE's Day Plan (stopSequence 1) so the urgent ticket leads the day — the rest keep their order.
     */
    insertAtTop = false,
    /**
     * #249 — the caller's explicit decision to assign a ticket that is deferred to a future return
     * date. Absent (the default) means the deferral is honoured and a held ticket is refused, so every
     * existing caller keeps its behaviour unless it deliberately opts in.
     */
    deferral: DeferralOverrideInput = {},
    /**
     * #283 — the chosen SE's coverage of this plant, when the caller already knows it. The intraday
     * CRITICAL path does: it picked `chosen` out of `orderedCandidatesForPlant` and holds
     * `chosen.coverageType` at the call site. Passing it through saves the lookup below *and* records
     * the tier the engine actually evaluated rather than one re-derived a moment later.
     */
    coverageAtAssign: CoverageAtAssign | null = null,
    /**
     * #325 (RC-9) — a caller's own write that must live or die with this assignment.
     *
     * `IntradayInsertionService` writes the `intraday_insertions` ledger row that *describes* the
     * assignment this method makes, and it could only do so after the transaction had committed: two
     * writers, two transactions, no shared boundary. A crash in the gap left an assigned CRITICAL
     * ticket with no ledger entry — invisible to the Intra-day Queue and absent from the efficiency
     * cube's inputs — or a queue row that says ACCEPTED while unable to name the schedule the work
     * went onto.
     *
     * A callback rather than an exported `tx`, deliberately. Handing the transaction client outward
     * invites a caller to re-read or re-decide inside somebody else's boundary; a callback that
     * receives only the ids this assignment just minted can do one thing — write the row that goes
     * with it. It runs LAST, after every write this method owns, so a hook that throws rolls back the
     * assignment and nothing else has to know that it might.
     *
     * It runs inside `retryOnceOnUniqueViolation`, so a `WorkSchedule` race re-runs it — safely, since
     * the losing attempt committed nothing. Notifications stay outside: {@link drainRows} below fires
     * only once the transaction has committed, which is what keeps AC2 ("never push for a rolled-back
     * assignment") true by construction rather than by ordering luck.
     */
    inTransaction: AssignInTransaction | null = null,
  ): Promise<AssignOutcome> {
    // The one caller that assigns as the engine rather than as a person (`IntradayInsertionService`
    // passes `SYSTEM_ACTOR`). It decides both halves of the provenance question — which door, and
    // whether a schedule created here is the system's or a manager's.
    const systemActor = actor.role === 'SYSTEM';
    const ticket = await this.prisma.ticket.findUnique({ where: { ticketId }, include: { plant: true } });
    if (!ticket || !this.inScope(ticket.plant.zoneId, scope)) return { result: 'NOT_FOUND' };
    if (ticket.assignmentState === 'FORMALLY_ASSIGNED') return { result: 'ALREADY_ASSIGNED' };
    const target = await this.prisma.engineerMaster.findUnique({ where: { engineerId: seId } });
    if (!target) return { result: 'NOT_FOUND' };

    // The **IST** calendar day (#240; CONTEXT.md Decisions §19) — `date_from`/`date_to` are `@db.Date`,
    // and a UTC-derived day put a 00:00–05:29 IST manual assign on *yesterday's* schedule: a different
    // row from the one `dispatchForZone` builds and the Day Plan reads for the same instant.
    const day = istDate(now);

    // #249 / Decision 17 — a return-date deferral may be overridden, never bypassed.
    //
    // This method checked existence, scope and ALREADY_ASSIGNED and never consulted the deferral, so a
    // one-click assign put a ticket whose vehicle is away until Friday straight onto today's plan, with
    // nothing in the trail naming the hold it walked through. The bulk path already filtered at
    // selection (#146), which is exactly what hid this: the gap is only reachable by handing a ticket
    // to this primitive directly. Boundary is `isNotDeferredOn`, the same predicate every reader of
    // unassigned work spreads in — inclusive on the deferred day itself, so a lapsed deferral is not a
    // hold and the normal path gains no friction at all.
    const held = !isNotDeferredOn(ticket.deferredUntil, day);
    if (held) {
      const vuReport = await this.openVuContext(ticketId);
      if (deferral.confirm !== true) {
        return {
          result: 'CONFLICT_DEFERRED',
          ticketId,
          deferredUntil: ticket.deferredUntil!.toISOString(),
          vuReport,
        };
      }
      // Mirrors the ON_SITE gate: confirming is not enough on its own. Overruling a hold somebody
      // placed for a stated reason is the one action whose "why" is the entire accountability record.
      if (!deferral.reasonCode || deferral.reasonCode.trim() === '') return { result: 'REASON_REQUIRED' };
      await this.prisma.auditLog.create({
        data: {
          actorId: actor.userId,
          actorRole: actor.role,
          actedAsRole: actor.actedAsRole ?? null,
          actingZone: actor.actingZone != null ? BigInt(actor.actingZone) : null,
          action: 'OVERRIDE_DEFERRED_ASSIGN',
          entityType: 'ticket',
          entityId: ticketId,
          metadata: {
            seId,
            deferredUntil: ticket.deferredUntil!.toISOString(),
            reasonCode: deferral.reasonCode.trim(),
            // Named, not decided: the report itself is untouched. Overriding the hold says "assign it
            // anyway", not "the vehicle is back" — only #245's decide path may move the return date.
            vuReportId: vuReport?.id ?? null,
          } as Prisma.InputJsonValue,
        },
      });
    }
    // #265 — the `ALREADY_ASSIGNED` guard above reads `tickets.assignment_state` OUTSIDE this
    // transaction, so two managers assigning one ticket both pass it and the loser's create lands on
    // `batch_assignment_tickets_one_active_per_ticket`. That P2002 was never caught: it left the
    // service as an unhandled 500, on a path both controllers map deliberately to a 409 for exactly
    // this condition. It cannot be caught *inside* the block below either — a P2002 aborts the whole
    // Postgres transaction — so the recovery wraps the call and lets the rollback do its work, which
    // is also what stops `withAudit` leaving an audit row for an assignment that never happened.
    let ids: { scheduleId: bigint; batchId: bigint; outboxId: bigint };
    const commit = () =>
      this.audit.withAudit(
        {
          actorId: actor.userId,
          actorRole: actor.role,
          actedAsRole: actor.actedAsRole ?? null,
          actingZone: actor.actingZone ?? null,
          action: auditAction,
          entityType: 'ticket',
          entityId: ticketId,
          metadata: (auditAction === 'MANUAL_ZM_UPDATE'
            ? { seId, updateType: 'ADD' }
            : { seId }) as Prisma.InputJsonValue,
        },
        async (tx) => {
          // #327 (RC-12) — the ticket row FIRST, before this transaction writes anything at all.
          //
          // This method used to insert the batch-ticket row and update `tickets` afterwards, which is
          // the exact inverse of `assignLane`. Two managers on one ticket then held each other's next
          // row and Postgres broke the cycle with a 40P01: a 500 on one door and a reasonless
          // `LANE_FAILED` on the other, for a condition both doors already answer with a 409.
          //
          // Blocking `FOR UPDATE`, deliberately NOT the lane's `SKIP LOCKED`. A lane skips because a
          // ticket it cannot lock has siblings waiting behind it and reporting one lost race is
          // cheaper than stalling the rest; this call is about one ticket and has nothing to get on
          // with, so waiting for the concurrent writer to finish is what lets it give the *true*
          // answer instead of a guess. Under READ COMMITTED the lock re-evaluates the row, so the
          // state read here is the winner's committed state, not the one we read before the
          // transaction opened.
          //
          // An absent row folds into the same refusal rather than earning a branch: the pre-read above
          // found this ticket and tickets are never deleted, so `length === 0` is unreachable — and
          // "somebody else owns it now" is the honest answer to every way of getting here.
          const locked = await tx.$queryRaw<Array<{ assignment_state: string }>>`
            SELECT assignment_state FROM tickets WHERE ticket_id = ${ticketId}::uuid FOR UPDATE`;
          if (locked.length === 0 || locked[0].assignment_state === 'FORMALLY_ASSIGNED') {
            // Throws rather than returns: `withAudit` writes the audit row in this same transaction,
            // and a refusal must leave no trail claiming an assignment that never happened (#265).
            throw new LostRaceError('ASSIGN_TICKET');
          }
          const sched = await this.ensureSchedule(
            tx,
            seId,
            { zoneId: ticket.plant.zoneId, dateFrom: day, dateTo: day },
            now,
            systemActor,
          );
          let batch = await tx.plantBatchAssignment.findFirst({
            where: { scheduleId: sched.scheduleId, plantId: ticket.plantId, seId },
          });
          if (!batch) {
            batch = await tx.plantBatchAssignment.create({
              data: {
                scheduleId: sched.scheduleId,
                plantId: ticket.plantId,
                seId,
                status: 'AUTO_ASSIGNED',
                stopSequence: await this.nextStopSequence(tx, sched.scheduleId),
              },
            });
          }
          await tx.batchAssignmentTicket.create({
            data: {
              batchId: batch.batchId,
              ticketId,
              sortOrder: await this.nextSortOrder(tx, batch.batchId),
              // #283 — who put this here, and through which door. `actor.userId` is the literal
              // 'SYSTEM' on the intraday CRITICAL path, which is exactly the case that used to be
              // indistinguishable from a ZM's one-click assign: both wrote a bare row and both
              // audited as CRITICAL_ASSIGN.
              addSource: addProvenanceSourceFor(auditAction, systemActor),
              addedBy: systemActor ? null : actor.userId,
              addReason: deferral.reasonCode ?? null,
              coverageTypeAtAssign:
                coverageAtAssign ?? (await resolveCoverageAtAssign(tx, seId, ticket.plantId)),
              // Stamped from the caller's clock rather than left to the column default, so both legs
              // of one operation agree: the removal side has always written `removedAt: now`, and a
              // DB-evaluated `now()` on this side put the two ends of a single reassignment at
              // different instants — which is precisely what a day-bounded ledger cannot tolerate.
              createdAt: now,
            },
          });
          // #249 AC2 — the deferral is spent by the assignment, exactly as `dispatchForZone` spends it.
          // Leaving a future date on a FORMALLY_ASSIGNED ticket is the verified stale-deferral edge this
          // closes: the batch row and the audit trail are the durable record of what was overridden, and
          // a live `deferred_until` on assigned work only misleads whatever reads it next.
          await tx.ticket.update({
            where: { ticketId },
            data: { assignmentState: 'FORMALLY_ASSIGNED', deferredUntil: null },
          });
          // #298 (CB-2) — an assignment is the decision the escalation was asking for, so it closes it,
          // in the transaction that makes the assignment. Verbatim the treatment `moveTickets` already
          // gives (:1149), and for the same reason its comment states: an escalation nothing can clear
          // would leave the Console strip and the Intra-day Queue asking for a decision already taken,
          // and #268's re-escalation guard would key on a row no door could ever close.
          //
          // Until this, only `moveTickets` and the queue's own `manualAssign` closed one — so an
          // operator who took the strip's *own* "Assign this work →" door (`ActionsBand` →
          // `POST /schedules/assign` → here) saw the row return on refetch, still counted in
          // `criticalNeedsYou`, now reading "Reassign this work →". Every layer looked correct alone.
          //
          // `updateMany` guarded on the status, not a bare `update`: a concurrent `manualAssign` on the
          // same insertion must not be double-responded, and the guard makes whichever writer arrives
          // second a no-op rather than an overwrite of the first one's actor and instant. Removal is
          // deliberately NOT a closer (#288) — a ticket taken off the plan is genuinely unassigned work
          // that still needs somebody.
          await tx.intradayInsertion.updateMany({
            where: { ticketId, status: 'ESCALATION_REQUIRED' },
            data: { status: 'ACCEPTED', offeredSeId: seId, respondedAt: now },
          });
          if (insertAtTop) await this.moveBatchToTop(tx, sched.scheduleId, batch.batchId);
          // #264 — written inside this same transaction as everything above: a retried/rolled-back
          // attempt (the P2002 recovery below) never leaves a ghost outbox row.
          const outboxId = await queueDayPlanOverridden(tx, { seId, scheduleId: sched.scheduleId, batchId: batch.batchId, action: auditAction });
          // #325 — last, so the caller's ledger row is written against ids that are final, and so a
          // hook that throws takes every write above it with it.
          if (inTransaction) await inTransaction(tx, { scheduleId: sched.scheduleId, batchId: batch.batchId });
          return { scheduleId: sched.scheduleId, batchId: batch.batchId, outboxId };
        },
      );

    try {
      // Two different races, two different answers. A concurrent assign to the same ENGINEER only
      // costs us their schedule row, which our retry then finds and shares — that caller did nothing
      // wrong. A concurrent assign of the same TICKET means somebody else owns it now, and the honest
      // answer is the 409 both controllers already map.
      ids = await retryOnceOnUniqueViolation('WorkSchedule', commit);
    } catch (e: unknown) {
      // #327 — the guarded re-read at the top of the transaction now reports the same race the P2002
      // below used to report after the fact. The unique violation stays as the braces to its belt: it
      // is the database's own answer, and it also covers a racer that inserts without locking.
      if (e instanceof LostRaceError) return { result: 'ALREADY_ASSIGNED' };
      if (isUniqueViolationOn(e, 'BatchAssignmentTicket')) return { result: 'ALREADY_ASSIGNED' };
      // #327 — a residual 40P01, from a writer outside this file's acquisition order. The counterpart
      // of a deadlock on this transaction is by construction another writer on this same ticket, so
      // the conflict both controllers already map (409 `TICKET_ALREADY_ASSIGNED`) is the truthful
      // answer as well as the available one — and it tells the operator the one useful thing, which is
      // to look again. The transaction rolled back whole, so nothing is half-written behind it.
      if (isDeadlock(e)) return { result: 'ALREADY_ASSIGNED' };
      throw e;
    }

    await drainRows(this.prisma, this.notifier, [ids.outboxId], now);
    return { result: 'OK', scheduleId: String(ids.scheduleId), batchId: String(ids.batchId), ticketId, seId };
  }

  /**
   * Manual multi-plant SE assignment (Issue 122b, Device Detail page) — a shorthand over
   * {@link assignBatch} (#275): expands the selected plants to their assignable ticket ids and
   * delegates to the one write path every manual assign now shares (schedules, plant batches, stop
   * ordering, audit rows, notifications and the Shared-Pool exit all still run through
   * {@link assignLane}, the same primitive `assign-batch` uses). `PlantAssignSummary` is unchanged —
   * the Device Detail panel and Commissioning Cohort keep working against the same response shape
   * (`assignable-work.e2e-spec.ts` / `issue-122b-fleet-assign.e2e-spec.ts` pin it byte-for-byte).
   *
   * **Fold, not itemise, for this legacy shape.** `assignLane` itemises a lost race in `skipped`
   * rather than folding it into `alreadyAssigned` (#275's own requirement for the new endpoint) — but
   * `PlantAssignSummary` predates that vocabulary and has no `skipped` field at all. The pre-#275
   * behaviour counted every `ALREADY_ASSIGNED` outcome (races included) into one number, so a lost
   * race is folded back into `alreadyAssigned` here to keep the old contract's arithmetic identical.
   * `NOT_FOUND`/`OUT_OF_ZONE`/`CONFLICT_DEFERRED` stay silently dropped, exactly as the old per-ticket
   * loop dropped a `NOT_FOUND`/`CONFLICT_DEFERRED` outcome from `assignTicket` — uncounted on either
   * side, the plant's own "vanished" gap (`openUnassigned − assigned − alreadyAssigned`).
   */
  async assignPlants(
    plantIds: string[],
    seId: string,
    scope: ZmScope,
    actor: ActorContext,
    now: Date = new Date(),
  ): Promise<PlantAssignSummary | { result: 'SE_NOT_FOUND' }> {
    const se = await this.prisma.engineerMaster.findUnique({ where: { engineerId: seId } });
    if (!se) return { result: 'SE_NOT_FOUND' };

    const ids = plantIds.filter((p) => /^\d+$/.test(p)).map((p) => BigInt(p));
    const perPlant = new Map<string, { assigned: number; openUnassigned: number }>();
    const allTicketIds: string[] = [];

    for (const plantId of ids) {
      const open = await this.prisma.ticket.findMany({
        // #146 — a bulk "assign this plant's open work to an SE" must not silently resurrect a ticket
        // another ZM deliberately deferred to a future date. The deferral is still an explicit human
        // decision; a ZM who wants it back today can re-assign that ticket directly.
        //
        // #273 — this predicate moved to `ticketing/assignable-work.ts` and is now shared with the
        // Assign Work Console's work pool. It is the definition of "work this button will move", and
        // the console shows that count beside the button, so the two cannot be allowed to drift: a
        // read spelled even slightly differently would promise the operator a number this loop does
        // not deliver. `assignable-work.e2e-spec.ts` asserts the read predicts this write.
        where: { plantId, ...assignableTickets(now) },
        select: { ticketId: true },
        orderBy: { createdAt: 'asc' },
      });
      perPlant.set(String(plantId), { assigned: 0, openUnassigned: open.length });
      for (const t of open) allTicketIds.push(t.ticketId);
    }

    const buildSummary = (): PlantAssignSummary => ({
      seId,
      assigned: 0,
      alreadyAssigned: 0,
      perPlant: [...perPlant].map(([plantId, v]) => ({ plantId, ...v })),
    });
    if (allTicketIds.length === 0) return buildSummary();

    let detail: LaneDetail;
    try {
      detail = await this.assignLane(
        { seId, ticketIds: allTicketIds },
        'Manual plant assignment',
        scope,
        actor,
        now,
        istDate(now),
        'MANUAL_PLANT_ASSIGN',
      );
    } catch (e: unknown) {
      // #327 — `assignBatch` folds a thrown lane into `LANE_FAILED`; this legacy shape has no such
      // member, so the same throw reached the controller as a 500. A deadlocked lane committed nothing,
      // and the summary can say exactly that: `assigned: 0` against the plants' unchanged open counts,
      // which is the "vanished" gap this shape already uses for every outcome it has no field for.
      if (isDeadlock(e)) return buildSummary();
      throw e;
    }
    if (!detail.ok) return { result: 'SE_NOT_FOUND' };

    for (const ticketId of detail.assignedTicketIds) {
      const plantId = String(detail.assignedPlantIds.get(ticketId));
      const row = perPlant.get(plantId);
      if (row) row.assigned += 1;
    }
    const lostRace = detail.skipped.filter((s) => s.reason === 'LOST_RACE').length;

    const summary = buildSummary();
    summary.assigned = detail.assignedTicketIds.length;
    summary.alreadyAssigned = detail.alreadyAssignedTicketIds.length + lostRace;
    return summary;
  }

  /**
   * `POST /schedules/assign-batch` primitive (#275) — one transaction per lane (see {@link assignLane}),
   * one result row per lane. A lane that throws — an unexpected error, not one of the honest skip
   * reasons {@link assignLane} reports — is caught here and reported `LANE_FAILED` without touching the
   * others; that isolation is the entire point of the per-lane transaction boundary.
   */
  async assignBatch(
    lanes: AssignBatchLane[],
    reasonCode: string,
    scope: ZmScope,
    actor: ActorContext,
    now: Date = new Date(),
    auditAction = 'MANUAL_BATCH_ASSIGN',
  ): Promise<AssignBatchResult> {
    const day = istDate(now);
    const results: AssignBatchLaneResult[] = [];
    for (const lane of lanes) {
      try {
        const detail = await this.assignLane(lane, reasonCode, scope, actor, now, day, auditAction);
        results.push(
          detail.ok
            ? {
                seId: detail.seId,
                result: 'OK',
                assigned: detail.assignedTicketIds.length,
                alreadyAssigned: detail.alreadyAssignedTicketIds.length,
                skipped: detail.skipped,
                scheduleId: detail.scheduleId ? String(detail.scheduleId) : undefined,
                batchIds: detail.batchIds.map(String),
              }
            : { seId: detail.seId, result: 'SE_NOT_FOUND', assigned: 0, alreadyAssigned: 0, skipped: [], batchIds: [] },
        );
      } catch {
        results.push({ seId: lane.seId, result: 'LANE_FAILED', assigned: 0, alreadyAssigned: 0, skipped: [], batchIds: [] });
      }
    }
    return { lanes: results };
  }

  /**
   * One engineer's slice of a manual plan, in one transaction (#275, matching #262's per-unit shape:
   * one transaction per SE, not per ticket and not per whole batch). Every ticket is re-read and
   * re-verified under this same transaction immediately before it is written, so a ticket that changed
   * state since the caller last looked — assigned by someone else, deferred, moved out of scope — is
   * caught here rather than trusted from a stale read.
   *
   * Deliberately **not** the single-ticket `assignTicket` shape of "insert, catch the unique-violation,
   * re-read": #265 found that a P2002 aborts the *whole* Postgres transaction, and this transaction is
   * now shared across every ticket in the lane — one collision would silently roll back every sibling
   * ticket already written in it. `FOR UPDATE ... SKIP LOCKED` immediately before the write closes the
   * same race without ever risking that abort: a row currently held by a concurrent writer is simply
   * invisible to this query, never an error.
   *
   * #327 — that lock is also the head of the acquisition order the whole file now shares (see the note
   * above the class). This method is unchanged by that slice: `assignTicket` moved to match it, because
   * unwinding the SKIP LOCKED re-verify to match `assignTicket` instead would have given back exactly
   * the abort the paragraph above exists to prevent.
   */
  private async assignLane(
    lane: AssignBatchLane,
    reasonCode: string,
    scope: ZmScope,
    actor: ActorContext,
    now: Date,
    day: Date,
    auditAction: string,
  ): Promise<LaneDetail> {
    const se = await this.prisma.engineerMaster.findUnique({ where: { engineerId: lane.seId } });
    if (!se) return { seId: lane.seId, ok: false, reason: 'SE_NOT_FOUND' };

    const assignedTicketIds: string[] = [];
    const assignedPlantIds = new Map<string, bigint>();
    const alreadyAssignedTicketIds: string[] = [];
    const skipped: { ticketId: string; reason: AssignBatchSkipReason }[] = [];
    const outboxIds: bigint[] = [];
    let scheduleId: bigint | undefined;
    const batchIds = new Set<bigint>();
    // #283 — coverage is a property of (engineer, plant), and a lane routinely spans several plants
    // but only ever one engineer. Resolving per ticket inside the loop would multiply queries by the
    // lane size for an answer that changes only when the plant does, so it is memoised per plant.
    const coverageByPlant = new Map<string, CoverageAtAssign>();

    await this.prisma.$transaction(async (tx) => {
      for (const ticketId of lane.ticketIds) {
        const ticket = await tx.ticket.findUnique({ where: { ticketId }, include: { plant: true } });
        if (!ticket) {
          skipped.push({ ticketId, reason: 'NOT_FOUND' });
          continue;
        }
        if (!this.inScope(ticket.plant.zoneId, scope)) {
          skipped.push({ ticketId, reason: 'OUT_OF_ZONE' });
          continue;
        }
        if (ticket.assignmentState === 'FORMALLY_ASSIGNED') {
          alreadyAssignedTicketIds.push(ticketId);
          continue;
        }
        if (!isNotDeferredOn(ticket.deferredUntil, day)) {
          skipped.push({ ticketId, reason: 'CONFLICT_DEFERRED' });
          continue;
        }

        // Re-verify under lock immediately before writing — closes the gap between the read above and
        // this write for a genuine concurrent racer (#265's class of defect), without an abort risk.
        const locked = await tx.$queryRaw<Array<{ assignment_state: string }>>`
          SELECT assignment_state FROM tickets WHERE ticket_id = ${ticketId}::uuid
            FOR UPDATE OF tickets SKIP LOCKED`;
        if (locked.length === 0 || locked[0].assignment_state === 'FORMALLY_ASSIGNED') {
          // Either a concurrent writer holds this exact row right now (SKIP LOCKED made it invisible),
          // or they finished first between our read and this lock. Either way: lost the race, reported
          // — never a silent skip and never the 500 an unguarded insert would have risked.
          skipped.push({ ticketId, reason: 'LOST_RACE' });
          continue;
        }

        const sched = await this.ensureSchedule(tx, lane.seId, { zoneId: ticket.plant.zoneId, dateFrom: day, dateTo: day }, now);
        scheduleId = sched.scheduleId;
        let batch = await tx.plantBatchAssignment.findFirst({
          where: { scheduleId: sched.scheduleId, plantId: ticket.plantId, seId: lane.seId },
        });
        if (!batch) {
          batch = await tx.plantBatchAssignment.create({
            data: {
              scheduleId: sched.scheduleId,
              plantId: ticket.plantId,
              seId: lane.seId,
              status: 'AUTO_ASSIGNED',
              stopSequence: await this.nextStopSequence(tx, sched.scheduleId),
            },
          });
        }
        batchIds.add(batch.batchId);
        const plantKey = String(ticket.plantId);
        if (!coverageByPlant.has(plantKey)) {
          coverageByPlant.set(plantKey, await resolveCoverageAtAssign(tx, lane.seId, ticket.plantId));
        }
        await tx.batchAssignmentTicket.create({
          data: {
            batchId: batch.batchId,
            ticketId,
            sortOrder: await this.nextSortOrder(tx, batch.batchId),
            // The lane's reason is mandatory at the controller (#275), so this is the one add path
            // that always carries a real human "why" onto the row itself rather than only into audit.
            addSource: addProvenanceSourceFor(auditAction, false),
            addedBy: actor.userId,
            addReason: reasonCode,
            coverageTypeAtAssign: coverageByPlant.get(plantKey) ?? null,
            createdAt: now,
          },
        });
        await tx.ticket.update({
          where: { ticketId },
          data: { assignmentState: 'FORMALLY_ASSIGNED', deferredUntil: null },
        });
        // Same shape as a single `assignTicket` call — this endpoint adds no new audit semantics for
        // the per-ticket row; the mandatory reason is recorded once below, for the lane as a whole.
        await tx.auditLog.create({
          data: {
            actorId: actor.userId,
            actorRole: actor.role,
            actedAsRole: actor.actedAsRole ?? null,
            actingZone: actor.actingZone != null ? BigInt(actor.actingZone) : null,
            action: auditAction,
            entityType: 'ticket',
            entityId: ticketId,
            metadata: { seId: lane.seId } as Prisma.InputJsonValue,
          },
        });
        const outboxId = await queueDayPlanOverridden(tx, {
          seId: lane.seId,
          scheduleId: sched.scheduleId,
          batchId: batch.batchId,
          action: auditAction,
        });
        outboxIds.push(outboxId);
        assignedTicketIds.push(ticketId);
        assignedPlantIds.set(ticketId, ticket.plantId);
      }

      // #298 (CB-2) — the same escalation close `assignTicket` does, for the Console's *other* assign
      // door: the Assign-mode draft commits through `assign-batch`, which does not route through
      // `assignTicket` at all (this lane is its own transaction, deliberately — see the docblock), so
      // a stamp there would never have run here. One `updateMany` for the lane rather than one per
      // ticket: the assignee is the same for every ticket in it, which is the only value that varies.
      // Scoped to the tickets this lane actually wrote — a skipped or already-assigned ticket resolved
      // nothing and must leave its escalation open.
      if (assignedTicketIds.length > 0) {
        await tx.intradayInsertion.updateMany({
          where: { ticketId: { in: assignedTicketIds }, status: 'ESCALATION_REQUIRED' },
          data: { status: 'ACCEPTED', offeredSeId: lane.seId, respondedAt: now },
        });
      }

      // The mandatory reason (#275 required-change #1) — one row per lane, separate from each ticket's
      // own assignment audit row above, so "why this plan was made" is recorded even for a lane that
      // ended up assigning nothing (every ticket skipped or already done).
      await tx.auditLog.create({
        data: {
          actorId: actor.userId,
          actorRole: actor.role,
          actedAsRole: actor.actedAsRole ?? null,
          actingZone: actor.actingZone != null ? BigInt(actor.actingZone) : null,
          action: 'ASSIGN_BATCH_COMMIT',
          entityType: 'assign_batch_lane',
          entityId: lane.seId,
          metadata: {
            reasonCode,
            ticketIds: lane.ticketIds,
            assigned: assignedTicketIds.length,
            alreadyAssigned: alreadyAssignedTicketIds.length,
            skipped,
          } as Prisma.InputJsonValue,
        },
      });
    });

    await drainRows(this.prisma, this.notifier, outboxIds, now);

    return {
      seId: lane.seId,
      ok: true,
      assignedTicketIds,
      assignedPlantIds,
      alreadyAssignedTicketIds,
      skipped,
      scheduleId,
      batchIds: [...batchIds],
    };
  }

  private async swapSe(
    batch: BatchWithSchedule,
    cmd: Extract<OverrideCommand, { action: 'SWAP_SE' }>,
    actor: ActorContext,
    now: Date,
  ): Promise<OverrideOutcome> {
    const target = await this.prisma.engineerMaster.findUnique({ where: { engineerId: cmd.newSeId } });
    if (!target) return { result: 'NOT_FOUND' };

    // #265 item 5 (the sweep) — `swapSe` reaches `ensureSchedule` too, so it carried the identical
    // unhandled schedule race: swap two engineers' work at the same moment somebody else assigns to
    // the target, and the swap 500s. Same recovery, same reason.
    const swapped = await retryOnceOnUniqueViolation('WorkSchedule', () =>
      this.audit.withAudit(
        this.auditEntry(actor, batch.batchId, {
          action: cmd.action,
          fromSeId: batch.seId,
          newSeId: cmd.newSeId,
          reasonCode: cmd.reasonCode,
        }),
        async (tx) => {
          // #334 — the source schedule is named here, so both ends of the swap are taken in one
          // deterministic order at the top of the transaction. The stamp below then writes a row this
          // transaction already holds, instead of reaching for it after the destination is locked.
          const sched = await this.ensureSchedule(tx, cmd.newSeId, batch.schedule, now, false, batch.scheduleId);
          const seq = await this.nextStopSequence(tx, sched.scheduleId);
          await tx.plantBatchAssignment.update({
            where: { batchId: batch.batchId },
            data: { scheduleId: sched.scheduleId, seId: cmd.newSeId, status: 'OVERRIDDEN', overrideReason: cmd.reasonCode, stopSequence: seq },
          });
          // #265 item 5 — `swapSe` spells the same stamp inline, so it carried the same resurrection
          // defect as `flagOverridden`. Same guard, same reason.
          await tx.workSchedule.updateMany({
            where: { scheduleId: batch.scheduleId, ...liveScheduleFilter() },
            data: { status: 'OVERRIDDEN', lastOverriddenBy: actor.userId, lastOverriddenAt: now },
          });
          const outboxId = await queueDayPlanOverridden(tx, { seId: cmd.newSeId, scheduleId: sched.scheduleId, batchId: batch.batchId, action: cmd.action });
          return { scheduleId: sched.scheduleId, outboxId };
        },
      ),
    );

    await drainRows(this.prisma, this.notifier, [swapped.outboxId], now);
    return { result: 'OK', batchId: String(batch.batchId), scheduleId: String(swapped.scheduleId), seId: cmd.newSeId, status: 'OVERRIDDEN' };
  }

  /**
   * Shared mover for REASSIGN (one ticket), SPLIT_BATCH (a subset) and MOVE_TICKET (one ticket onto
   * another day): move tickets to a same-plant batch under the target SE's schedule for the target
   * day; the source batch + schedule flip OVERRIDDEN.
   *
   * **The day axis is one argument, and that is the whole of the cross-day fix.** This method was
   * always a general cross-*schedule* mover — it resolves a destination schedule, opens a plant batch
   * under it, closes each source row and opens a destination row. It was same-day only because it
   * handed `batch.schedule` to `ensureSchedule`, inheriting the source's `[dateFrom, dateTo]`.
   * `targetDay` replaces that range with a single-day one, and every other property the mover already
   * guarantees carries over untouched:
   *
   * - the ticket is **never** `UNASSIGNED` in between — the two rows are written in one transaction,
   *   so no run and no reader can ever see the work unowned (this is the property `DEFER_TICKET`
   *   structurally cannot offer, because unassigning is what a defer *means*);
   * - `batch_assignment_tickets_one_active_per_ticket` makes a duplicate on both days impossible at
   *   the database rather than by our care;
   * - the destination lands on a live `work_schedules` row for that day, which the dispatch run
   *   *appends to* rather than replaces (`batch-assignment.service.ts` — "an earlier dispatch run
   *   today, or a ZM_MANUAL plan"), and whose ticket the run will not re-plan because the recommender
   *   selects `assignment_state = 'UNASSIGNED'` and this ticket is not. Scheduler ownership needs no
   *   new flag: being assigned already means the engine leaves it alone.
   *
   * `deferred_until` is deliberately **not** cleared, matching this method's existing posture (only an
   * *assignment* spends a deferral; a move preserves it and the confirm gate above makes overriding
   * one a seen decision).
   */
  private async moveTickets(
    batch: BatchWithSchedule,
    ticketIds: string[],
    newSeId: string,
    action: string,
    reasonCode: string,
    actor: ActorContext,
    now: Date,
    /**
     * The IST operating day the work moves **to**. Omitted — REASSIGN / SPLIT_BATCH — the destination
     * inherits the source schedule's own range, which is what makes those two same-day by definition.
     */
    targetDay?: Date,
  ): Promise<OverrideOutcome> {
    const target = await this.prisma.engineerMaster.findUnique({ where: { engineerId: newSeId } });
    if (!target) return { result: 'NOT_FOUND' };
    const rows = await this.prisma.batchAssignmentTicket.findMany({
      where: { batchId: batch.batchId, ticketId: { in: ticketIds }, removedAt: null },
    });
    if (rows.length !== ticketIds.length) return { result: 'NOT_FOUND' };

    let moved: { scheduleId: bigint; batchId: bigint; outboxId: bigint };
    try {
      // #265 item 5 — and `moveTickets` likewise. A LostRaceError from the guarded stamp below is not
      // a unique violation, so it passes straight through the retry to the catch that answers it.
      moved = await retryOnceOnUniqueViolation('WorkSchedule', () =>
        this.audit.withAudit(
          this.auditEntry(actor, batch.batchId, {
            action,
            ticketIds,
            newSeId,
            reasonCode,
            fromSeId: batch.seId,
            // Present only for a cross-day move, and load-bearing when it is: without it the trail
            // records that work moved and not *when to*, which is the only thing that distinguishes
            // this from an ordinary reassignment.
            ...(targetDay ? { targetDate: targetDay.toISOString().slice(0, 10), fromDate: batch.schedule.dateFrom.toISOString().slice(0, 10) } : {}),
          }),
          async (tx) => {
            const sched = await this.ensureSchedule(
              tx,
              newSeId,
              targetDay
                ? { zoneId: batch.schedule.zoneId, dateFrom: targetDay, dateTo: targetDay }
                : batch.schedule,
              now,
              false,
              // #334 — the source, so both ends are locked here in id order. `flagOverridden` at the
              // end of this transaction then stamps a row we already hold; before this, it was where a
              // move going the other way met us head-on.
              batch.scheduleId,
            );
            let targetBatch = await tx.plantBatchAssignment.findFirst({
              where: { scheduleId: sched.scheduleId, plantId: batch.plantId, seId: newSeId },
            });
            if (!targetBatch) {
              targetBatch = await tx.plantBatchAssignment.create({
                data: {
                  scheduleId: sched.scheduleId,
                  plantId: batch.plantId,
                  seId: newSeId,
                  status: 'OVERRIDDEN',
                  overrideReason: reasonCode,
                  stopSequence: await this.nextStopSequence(tx, sched.scheduleId),
                },
              });
            }
            let sort = await this.nextSortOrder(tx, targetBatch.batchId);
            // #283 — a move is one plant and one destination engineer, so coverage resolves once for
            // the whole set rather than per moved ticket.
            const coverageAtAssign = await resolveCoverageAtAssign(tx, newSeId, batch.plantId);
            for (const r of rows) {
              // Update (mark removed) before insert so the one-active-batch-per-ticket partial unique holds.
              //
              // #265 — guarded, and note the consequence of it sitting inside the loop: losing the race on
              // ANY row fails the whole move. That is the point. A REASSIGN that moved three of four
              // tickets and reported success would leave a half-moved plan nobody asked for; the throw
              // rolls the transaction back whole, so the move either happens or it does not.
              await stampOnceOrLose(
                tx.batchAssignmentTicket,
                { id: r.id, removedAt: null },
                {
                  removedAt: now,
                  removedBy: actor.userId,
                  removalReason: REMOVAL_REASONS.REASSIGNED,
                  removalNote: reasonCode,
                },
                action,
              );
              await tx.batchAssignmentTicket.create({
                data: {
                  batchId: targetBatch.batchId,
                  ticketId: r.ticketId,
                  sortOrder: sort++,
                  // The two halves of a move are now symmetrical: the source row says REASSIGNED on
                  // the removal side, the destination row says who moved it here and why on the add
                  // side. #284's changes-today pairs them to count a swap once.
                  addSource: MOVE_ADD_SOURCE[action] ?? ADD_SOURCES.MANUAL_REASSIGN,
                  addedBy: actor.userId,
                  addReason: reasonCode,
                  coverageTypeAtAssign: coverageAtAssign,
                  // The same instant the source row is stamped `REASSIGNED` with, so the ledger can
                  // pair the two halves of this move inside one day window.
                  createdAt: now,
                },
              });
            }
            await this.flagOverridden(tx, batch.batchId, batch.scheduleId, reasonCode, actor, now);
            // #288 — a move is the human decision the stranded-work escalation was asking for, so it
            // closes it, in the same transaction that makes the move. Left open, the queue and the
            // cockpit strip would keep asking for a decision already taken, and #268's re-escalation
            // guard would key on a row nothing could ever clear. `ACCEPTED` is the terminal value
            // `manualAssign` already writes when a human places escalated work — one vocabulary rather
            // than a new enum member for the same fact. Removal is deliberately NOT a closer: a ticket
            // taken off the plan is genuinely unassigned work, still needing somebody, and the read
            // surfaces flip to offering Assign for it on their own.
            await tx.intradayInsertion.updateMany({
              where: { ticketId: { in: rows.map((r) => r.ticketId) }, status: 'ESCALATION_REQUIRED' },
              data: { status: 'ACCEPTED', offeredSeId: newSeId, respondedAt: now },
            });
            const outboxId = await queueDayPlanOverridden(tx, { seId: newSeId, scheduleId: sched.scheduleId, batchId: batch.batchId, action });
            return { scheduleId: sched.scheduleId, batchId: targetBatch.batchId, outboxId };
          },
        ),
      );
    } catch (e: unknown) {
      if (e instanceof LostRaceError) return { result: 'NOT_FOUND' };
      throw e;
    }

    await drainRows(this.prisma, this.notifier, [moved.outboxId], now);
    // A same-day move answers with the SOURCE batch and engineer — the object the caller named, whose
    // plan they are looking at — and that contract is pinned by the existing override specs.
    //
    // A cross-day move answers with the DESTINATION, and the asymmetry is deliberate: the source day
    // is precisely what the operator just stopped caring about. The Console needs the destination
    // schedule and day to know which column to take them to, and answering "se-1, today's schedule"
    // to "move this to Wednesday" would be the same silence that made the old defer feel like a
    // no-op. `movedToDate` is the field the UI keys the day-focus change on.
    if (targetDay) {
      return {
        result: 'OK',
        batchId: String(moved.batchId),
        scheduleId: String(moved.scheduleId),
        seId: newSeId,
        status: 'OVERRIDDEN',
        movedToDate: targetDay.toISOString().slice(0, 10),
      };
    }
    return { result: 'OK', batchId: String(batch.batchId), scheduleId: String(batch.scheduleId), seId: batch.seId, status: 'OVERRIDDEN' };
  }

  /**
   * Find the target SE's live schedule for the source date range, or create one.
   *
   * **#283 — the created row's `source` follows who is asking.** This method wrote `ZM_MANUAL`
   * unconditionally, which was correct for the four human callers and wrong for the fifth: the
   * intraday CRITICAL sweep reaches here as `SYSTEM_ACTOR`, so a plan the *engine* created for an
   * engineer who had none yet was stamped as a manager's manual plan. `SYSTEM_GENERATED` already
   * means "the system created this" and is exactly true of an engine CRITICAL insert, so no new
   * `ScheduleSource` value is needed — note that such a row carries no `run_id`, because no dispatch
   * run produced it.
   */
  private async ensureSchedule(
    tx: Prisma.TransactionClient,
    seId: string,
    source: { zoneId: bigint; dateFrom: Date; dateTo: Date },
    now: Date,
    systemActor = false,
    /**
     * #334 — the OTHER schedule this transaction is going to touch, when there is one. Passed by the
     * two-schedule movers ({@link swapSe}, {@link moveTickets}) so both ends are taken here, in one
     * deterministic order, rather than the destination here and the source at the far end of the
     * transaction. See {@link OverrideService.lockSchedulesInOrder}.
     */
    peerScheduleId?: bigint,
  ) {
    // #153 — the target SE's own plan may itself have been overridden earlier (a ZM commonly adjusts
    // several plans in one sitting). Matching ACTIVE only stacked a second ZM_MANUAL schedule on top of
    // the plan they were already working. Oldest-first, matching the dispatch APPEND path.
    //
    // #265 — the match is on `date_from` and **not** `date_to`, because that is what the constraint
    // says. `work_schedules_one_active_per_se_zone_day` is partial-unique on
    // `(se_id, zone_id, date_from) WHERE status = 'ACTIVE'`; `date_to` is not in it, and
    // `batch-assignment.service.ts:128` has always looked the row up on exactly those three columns.
    // This find asked for `date_to` too, so the two call sites gave different answers to "which row is
    // this engineer's schedule for this day" and the database agreed with only one of them. The cost
    // needed no race: any live schedule with a different `date_to` — a multi-day plan, which `swapSe`
    // and `moveTickets` propagate by handing the *source* batch's range down here, or a null one,
    // which the column allows — made every manual assign to that engineer find nothing, create, and
    // die on the index. Since the index permits no second ACTIVE row for the day, attaching to the
    // one that exists is not a compromise; it is the only legal outcome.
    const existing = await tx.workSchedule.findFirst({
      where: { seId, zoneId: source.zoneId, dateFrom: source.dateFrom, ...liveScheduleFilter() },
      orderBy: { scheduleId: 'asc' },
    });
    // #327 — every writer takes the schedule row before anything hanging off it, and this is the one
    // place all four of them obtain a schedule. A row created below needs no lock: this transaction's
    // own insert already holds it.
    //
    // #334 — and when the caller named a peer, both ends are taken here together, lowest id first.
    await this.lockSchedulesInOrder(tx, existing?.scheduleId, peerScheduleId);
    if (existing) return existing;
    return tx.workSchedule.create({
      data: {
        seId,
        zoneId: source.zoneId,
        dateFrom: source.dateFrom,
        dateTo: source.dateTo,
        status: 'ACTIVE',
        source: systemActor ? 'SYSTEM_GENERATED' : 'ZM_MANUAL',
        dispatchedAt: now,
      },
    });
  }

  /**
   * Take the schedule row before reading or renumbering the stops under it (#327, RC-13).
   *
   * `nextStopSequence` is a `max + 1` read with nothing serialising it, so two adds landing on one plan
   * together both saw the same maximum and both wrote the same stop number. "Cosmetic" until you notice
   * that every reader of a day plan orders by that column: with two stops sharing a number the SE's
   * route order became whichever row the index happened to return first, and could differ between two
   * reads of the same plan. The same `max + 1` shape mints `sort_order` inside a batch.
   *
   * The schedule row is the natural mutex: it is the thing the numbering is *of*, every path that mints
   * or renumbers already holds its id, and locking it serialises exactly those writers and nobody else
   * — a reader of the plan takes no lock and is not delayed by this.
   *
   * **Chosen over a `UNIQUE (schedule_id, stop_sequence)` index**, which the issue allowed and the probe
   * permitted (`scripts/probe-stop-sequence-duplicates.cjs` — zero existing duplicates on either column
   * across the dev fleet, so #155's rule would not have blocked one). A unique index cannot be used here
   * for a reason the probe cannot see: renumbering writes transient duplicates by construction —
   * {@link moveBatchToTop} sets the incoming batch to stop 1 while the outgoing first stop still holds 1
   * — so a non-deferrable index would refuse the very operation that heals the ordering, and Prisma
   * cannot express the DEFERRABLE constraint that would not. Prevention at the mint has no such edge,
   * and needs no migration.
   *
   * Ordered **after** the ticket row and before every batch row, so it extends the file's one
   * acquisition order rather than opening a second one.
   */
  private async lockSchedule(tx: Prisma.TransactionClient, scheduleId: bigint): Promise<void> {
    await tx.$queryRaw`SELECT schedule_id FROM work_schedules WHERE schedule_id = ${scheduleId} FOR UPDATE`;
  }

  /**
   * Take every schedule row this transaction will touch, ascending by id (#334).
   *
   * {@link lockSchedule} orders `work_schedules` against the tables around it. This orders the
   * `work_schedules` rows against *each other*, which the movers need and nothing else does: a move
   * has a source and a destination, and "destination first" is not an order — run two moves in
   * opposite directions between one pair of engineers and each holds the row the other needs next.
   * `swapSe` and `moveTickets` were the two writers #327 could not fix from inside its own boundary.
   *
   * Ascending id, because it is the one rule both movers can evaluate without knowing about each
   * other: it depends only on the pair of rows, never on which end of *this* move a row sits at. Two
   * movers therefore queue on the lower id instead of cycling, and the second one finds the work
   * already done and re-verifies rather than deadlocking. Any other total order would do; this one
   * needs no new column and no coordination.
   *
   * Duplicates collapse — a SPLIT_BATCH whose destination SE already owns the source schedule passes
   * the same id twice — and an absent peer, or a destination this transaction is about to *create*,
   * simply contributes nothing: a row we insert is one nobody else can see, so it cannot be half of a
   * cycle. A concurrent insert of the same `(se, zone, day)` still meets the partial unique, which is
   * the collision `retryOnceOnUniqueViolation` has always answered, not a lock-order problem.
   */
  private async lockSchedulesInOrder(
    tx: Prisma.TransactionClient,
    ...scheduleIds: (bigint | null | undefined)[]
  ): Promise<void> {
    const ordered = [...new Set(scheduleIds.filter((id): id is bigint => id != null))].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    for (const scheduleId of ordered) await this.lockSchedule(tx, scheduleId);
  }

  /** Renumber a schedule's batches so `batchId` leads at stopSequence 1; the rest keep their order. */
  private async moveBatchToTop(tx: Prisma.TransactionClient, scheduleId: bigint, batchId: bigint): Promise<void> {
    // #327 — under the schedule lock, so this renumber and a concurrent one cannot walk the same batch
    // rows in opposite orders, and so the read below cannot miss a stop another writer is adding.
    await this.lockSchedule(tx, scheduleId);
    const batches = await tx.plantBatchAssignment.findMany({ where: { scheduleId }, orderBy: { stopSequence: 'asc' } });
    const target = batches.find((b) => b.batchId === batchId);
    if (!target) return;
    const ordered = [target, ...batches.filter((b) => b.batchId !== batchId)];
    for (let i = 0; i < ordered.length; i++) {
      await tx.plantBatchAssignment.update({ where: { batchId: ordered[i].batchId }, data: { stopSequence: i + 1 } });
    }
  }

  private async nextStopSequence(tx: Prisma.TransactionClient, scheduleId: bigint): Promise<number> {
    // #327 — the read and the write that depends on it happen under one lock. Held already by every
    // caller that reached here through `ensureSchedule`; re-taking a row this transaction owns costs
    // nothing, and stating it here is what makes the mint correct on its own rather than by the grace
    // of its callers.
    await this.lockSchedule(tx, scheduleId);
    const max = await tx.plantBatchAssignment.aggregate({ where: { scheduleId }, _max: { stopSequence: true } });
    return (max._max.stopSequence ?? 0) + 1;
  }

  private async nextSortOrder(tx: Prisma.TransactionClient, batchId: bigint): Promise<number> {
    // #327 — the same mint one level down, guarded by the row its numbering belongs to. Reached only
    // from paths that already hold the enclosing schedule, so this adds a step to the existing order
    // rather than a second order.
    await tx.$queryRaw`SELECT batch_id FROM plant_batch_assignments WHERE batch_id = ${batchId} FOR UPDATE`;
    const max = await tx.batchAssignmentTicket.aggregate({ where: { batchId, removedAt: null }, _max: { sortOrder: true } });
    return (max._max.sortOrder ?? 0) + 1;
  }

  /** Flip the batch + its schedule to OVERRIDDEN, stamping reason + overrider. */
  private async flagOverridden(
    tx: Prisma.TransactionClient,
    batchId: bigint,
    scheduleId: bigint,
    reasonCode: string,
    actor: ActorContext,
    now: Date,
  ): Promise<void> {
    // #327 — schedule row before the batch row under it, the same order the renumbering paths take.
    // Without it this stamp and a concurrent reorder would walk the two tables in opposite directions.
    await this.lockSchedule(tx, scheduleId);
    await tx.plantBatchAssignment.update({
      where: { batchId },
      data: { status: 'OVERRIDDEN', overrideReason: reasonCode },
    });
    // #265 item 5 — guarded on liveness, and this one was a real defect rather than a hardening.
    // `OVERRIDDEN` is a LIVE status (#153) while `COMPLETED`/`PARTIAL` are terminal, so an unguarded
    // write by primary key **resurrects a closed day plan** — precisely what `schedule-status.ts`
    // warns of: "widening past those would resurrect finished work onto today's plan". No race needed;
    // a manager acting on a stale screen after the 04:00 closure is enough.
    //
    // `updateMany` with no count check, deliberately: the withdrawal the manager asked for is still
    // valid on a finished plan (the ticket returns to the pool), and only the *provenance* stamp is
    // meaningless there. Whether an override should be refused outright on a terminal schedule is a
    // lifecycle question owned by #271, not one to smuggle in here.
    await tx.workSchedule.updateMany({
      where: { scheduleId, ...liveScheduleFilter() },
      data: { status: 'OVERRIDDEN', lastOverriddenBy: actor.userId, lastOverriddenAt: now },
    });
  }

  private auditEntry(
    actor: ActorContext,
    batchId: bigint,
    metadata: Record<string, unknown>,
    actionOverride?: string,
  ) {
    // Issue 31: a same-day update re-tags the action (e.g. MANUAL_ZM_UPDATE) and normalises the
    // command into an Intra-day Queue `updateType` (REMOVE_TICKET → REMOVE, REORDER → REORDER).
    const meta = actionOverride
      ? { ...metadata, updateType: String(metadata.action).replace(/_TICKET$/, '') }
      : metadata;
    return {
      actorId: actor.userId,
      actorRole: actor.role,
      actedAsRole: actor.actedAsRole ?? null,
      action: actionOverride ?? `BATCH_OVERRIDE_${String(metadata.action)}`,
      entityType: 'plant_batch_assignment',
      entityId: String(batchId),
      metadata: meta as Prisma.InputJsonValue,
    };
  }

  /** Tickets an override disturbs — used for the ON_SITE conflict check. Ticket-scoped actions name
   *  their ticket(s); batch-scoped actions (SWAP_SE / REORDER) disturb the batch's active tickets. */
  /**
   * The live vehicle wait behind a ticket's deferral, or null (#249).
   *
   * Read for the refusal and for the audit row, never written: the deferral is the hold, the report is
   * the explanation, and a ticket can be deferred by a ZM with no report at all. `findFirst` on OPEN is
   * exact — the partial unique index allows at most one per ticket.
   */
  /**
   * Which of these tickets are still held by a deferral on `day` (#249) — the negation of
   * `notDeferredOn`, run as one batched read so the gate costs a single query however many tickets a
   * SPLIT_BATCH touches. Order follows `ticketIds` so the refusal reads the same way twice.
   */
  private async deferredTicketIds(ticketIds: string[], day: Date): Promise<string[]> {
    if (ticketIds.length === 0) return [];
    const rows = await this.prisma.ticket.findMany({
      where: { ticketId: { in: ticketIds }, deferredUntil: { gt: day } },
      select: { ticketId: true },
    });
    const held = new Set(rows.map((r) => r.ticketId));
    return ticketIds.filter((id) => held.has(id));
  }

  private async openVuContext(ticketId: string): Promise<DeferralVuContext | null> {
    const report = await this.prisma.vehicleUnavailabilityReport.findFirst({
      where: { ticketId, status: 'OPEN' },
      select: { id: true, proposedFrom: true, expectedFrom: true },
    });
    return report
      ? {
          id: String(report.id),
          proposedFrom: report.proposedFrom.toISOString(),
          expectedFrom: report.expectedFrom.toISOString(),
        }
      : null;
  }

  private async affectedTicketIds(batch: BatchWithSchedule, cmd: OverrideCommand): Promise<string[]> {
    switch (cmd.action) {
      case 'REMOVE_TICKET':
      case 'DEFER_TICKET':
      case 'REASSIGN':
      case 'MOVE_TICKET':
        return [cmd.ticketId];
      case 'SPLIT_BATCH':
        return cmd.ticketIds;
      case 'SWAP_SE':
      case 'REORDER': {
        const rows = await this.prisma.batchAssignmentTicket.findMany({
          where: { batchId: batch.batchId, removedAt: null },
          select: { ticketId: true },
        });
        return rows.map((r) => r.ticketId);
      }
      default:
        // **An unrecognised action must not fall off the end of this switch.**
        //
        // TypeScript proves the cases exhaustive over `OverrideCommand`, so this looked unreachable
        // and was — until a client shipped ahead of the API. Then `cmd.action` is a string this
        // build has never heard of, the switch matches nothing, the function returns `undefined`,
        // and the caller's `activeOnSiteTicketIds(affected)` dies on `.length` — a bare 500 with a
        // stack trace, on a request whose real problem was a version skew.
        //
        // Type exhaustiveness is a compile-time proof about *this* build; the wire carries whatever
        // the caller sent. `[]` keeps the ON_SITE gate honest (an action we cannot interpret affects
        // no tickets we can name) and lets the dispatcher below answer for it properly.
        return [];
    }
  }

  private inScope(zoneId: bigint, scope: ZmScope): boolean {
    if (scope.role === 'ZONAL_MANAGER') return scope.zoneId != null && BigInt(scope.zoneId) === zoneId;
    return true; // CSM / Operations Head — cross-zone
  }
}
