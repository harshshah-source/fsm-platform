import { Inject, Injectable, Optional } from '@nestjs/common';
import { istDate } from '../common/ist-day';
import { LostRaceError, stampOnceOrLose } from '../common/lost-race';
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
}

export type OverrideCommand =
  | { action: 'REMOVE_TICKET'; ticketId: string; reasonCode: string; confirm?: boolean }
  | { action: 'DEFER_TICKET'; ticketId: string; deferredToDate: string; reasonCode: string; confirm?: boolean }
  | { action: 'REORDER'; stopSequence: number; reasonCode: string; confirm?: boolean }
  | { action: 'SWAP_SE'; newSeId: string; reasonCode: string; confirm?: boolean }
  | { action: 'REASSIGN'; ticketId: string; newSeId: string; reasonCode: string; confirm?: boolean }
  | { action: 'SPLIT_BATCH'; ticketIds: string[]; newSeId: string; reasonCode: string; confirm?: boolean };

export type OverrideOutcome =
  | { result: 'OK'; batchId: string; scheduleId: string; seId: string; status: string }
  | { result: 'NOT_FOUND' }
  | { result: 'CONFLICT_ON_SITE'; ticketIds: string[]; seId: string }
  /** #249 — one or more moved tickets carry a future return-date deferral; resend with `confirm`. */
  | { result: 'CONFLICT_DEFERRED'; ticketIds: string[]; seId: string };

/** Override actions that create work for a *different* SE, and so must not move a held ticket blind. */
const MOVE_ACTIONS: ReadonlySet<OverrideCommand['action']> = new Set(['SWAP_SE', 'REASSIGN', 'SPLIT_BATCH']);

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
            action: 'OVERRIDE_DEFERRED_MOVE',
            entityType: 'plant_batch_assignment',
            entityId: String(batch.batchId),
            metadata: { action: cmd.action, ticketIds: heldIds, reasonCode: cmd.reasonCode } as Prisma.InputJsonValue,
          },
        });
      }
    }

    switch (cmd.action) {
      case 'REMOVE_TICKET':
        return this.removeTicket(batch.batchId, batch.scheduleId, batch.seId, cmd, actor, now, auditAction);
      case 'DEFER_TICKET':
        return this.deferTicket(batch.batchId, batch.scheduleId, batch.seId, cmd, actor, now);
      case 'REORDER':
        return this.reorder(batch.batchId, batch.scheduleId, batch.seId, cmd, actor, now, auditAction);
      case 'SWAP_SE':
        return this.swapSe(batch, cmd, actor, now);
      case 'REASSIGN':
        return this.moveTickets(batch, [cmd.ticketId], cmd.newSeId, cmd.action, cmd.reasonCode, actor, now);
      case 'SPLIT_BATCH':
        return this.moveTickets(batch, cmd.ticketIds, cmd.newSeId, cmd.action, cmd.reasonCode, actor, now);
      default:
        return { result: 'NOT_FOUND' };
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
            { removedAt: now, removedBy: actor.userId, removalReason: REMOVAL_REASONS.ZM_WITHDRAWN },
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
    const batches = await this.prisma.plantBatchAssignment.findMany({
      where: { scheduleId },
      orderBy: { stopSequence: 'asc' },
    });
    const target = batches.find((b) => b.batchId === batchId);
    if (!target) return { result: 'NOT_FOUND' };

    // Insert the target at the requested 1-based position; the rest keep their relative order.
    const others = batches.filter((b) => b.batchId !== batchId);
    const pos = Math.max(1, Math.min(cmd.stopSequence, batches.length));
    const ordered = [...others];
    ordered.splice(pos - 1, 0, target);

    const outboxId = await this.audit.withAudit(
      this.auditEntry(actor, batchId, { action: cmd.action, stopSequence: pos, reasonCode: cmd.reasonCode, seId }, auditAction),
      async (tx) => {
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
          action: auditAction,
          entityType: 'ticket',
          entityId: ticketId,
          metadata: (auditAction === 'MANUAL_ZM_UPDATE'
            ? { seId, updateType: 'ADD' }
            : { seId }) as Prisma.InputJsonValue,
        },
        async (tx) => {
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
          if (insertAtTop) await this.moveBatchToTop(tx, sched.scheduleId, batch.batchId);
          // #264 — written inside this same transaction as everything above: a retried/rolled-back
          // attempt (the P2002 recovery below) never leaves a ghost outbox row.
          const outboxId = await queueDayPlanOverridden(tx, { seId, scheduleId: sched.scheduleId, batchId: batch.batchId, action: auditAction });
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
      if (isUniqueViolationOn(e, 'BatchAssignmentTicket')) return { result: 'ALREADY_ASSIGNED' };
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

    const detail = await this.assignLane(
      { seId, ticketIds: allTicketIds },
      'Manual plant assignment',
      scope,
      actor,
      now,
      istDate(now),
      'MANUAL_PLANT_ASSIGN',
    );
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

      // The mandatory reason (#275 required-change #1) — one row per lane, separate from each ticket's
      // own assignment audit row above, so "why this plan was made" is recorded even for a lane that
      // ended up assigning nothing (every ticket skipped or already done).
      await tx.auditLog.create({
        data: {
          actorId: actor.userId,
          actorRole: actor.role,
          actedAsRole: actor.actedAsRole ?? null,
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
          const sched = await this.ensureSchedule(tx, cmd.newSeId, batch.schedule, now);
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

  /** Shared mover for REASSIGN (one ticket) and SPLIT_BATCH (a subset): move tickets to a same-plant
   *  batch under the target SE's schedule; the source batch + schedule flip OVERRIDDEN. */
  private async moveTickets(
    batch: BatchWithSchedule,
    ticketIds: string[],
    newSeId: string,
    action: string,
    reasonCode: string,
    actor: ActorContext,
    now: Date,
  ): Promise<OverrideOutcome> {
    const target = await this.prisma.engineerMaster.findUnique({ where: { engineerId: newSeId } });
    if (!target) return { result: 'NOT_FOUND' };
    const rows = await this.prisma.batchAssignmentTicket.findMany({
      where: { batchId: batch.batchId, ticketId: { in: ticketIds }, removedAt: null },
    });
    if (rows.length !== ticketIds.length) return { result: 'NOT_FOUND' };

    let moved: { scheduleId: bigint; outboxId: bigint };
    try {
      // #265 item 5 — and `moveTickets` likewise. A LostRaceError from the guarded stamp below is not
      // a unique violation, so it passes straight through the retry to the catch that answers it.
      moved = await retryOnceOnUniqueViolation('WorkSchedule', () =>
        this.audit.withAudit(
          this.auditEntry(actor, batch.batchId, { action, ticketIds, newSeId, reasonCode, fromSeId: batch.seId }),
          async (tx) => {
            const sched = await this.ensureSchedule(tx, newSeId, batch.schedule, now);
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
                { removedAt: now, removedBy: actor.userId, removalReason: REMOVAL_REASONS.REASSIGNED },
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
                  addSource: action === 'SPLIT_BATCH' ? ADD_SOURCES.MANUAL_SPLIT : ADD_SOURCES.MANUAL_REASSIGN,
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
            return { scheduleId: sched.scheduleId, outboxId };
          },
        ),
      );
    } catch (e: unknown) {
      if (e instanceof LostRaceError) return { result: 'NOT_FOUND' };
      throw e;
    }

    await drainRows(this.prisma, this.notifier, [moved.outboxId], now);
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

  /** Renumber a schedule's batches so `batchId` leads at stopSequence 1; the rest keep their order. */
  private async moveBatchToTop(tx: Prisma.TransactionClient, scheduleId: bigint, batchId: bigint): Promise<void> {
    const batches = await tx.plantBatchAssignment.findMany({ where: { scheduleId }, orderBy: { stopSequence: 'asc' } });
    const target = batches.find((b) => b.batchId === batchId);
    if (!target) return;
    const ordered = [target, ...batches.filter((b) => b.batchId !== batchId)];
    for (let i = 0; i < ordered.length; i++) {
      await tx.plantBatchAssignment.update({ where: { batchId: ordered[i].batchId }, data: { stopSequence: i + 1 } });
    }
  }

  private async nextStopSequence(tx: Prisma.TransactionClient, scheduleId: bigint): Promise<number> {
    const max = await tx.plantBatchAssignment.aggregate({ where: { scheduleId }, _max: { stopSequence: true } });
    return (max._max.stopSequence ?? 0) + 1;
  }

  private async nextSortOrder(tx: Prisma.TransactionClient, batchId: bigint): Promise<number> {
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
    }
  }

  private inScope(zoneId: bigint, scope: ZmScope): boolean {
    if (scope.role === 'ZONAL_MANAGER') return scope.zoneId != null && BigInt(scope.zoneId) === zoneId;
    return true; // CSM / Operations Head — cross-zone
  }
}
