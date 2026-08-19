import { Inject, Injectable, Optional } from '@nestjs/common';
import { istDate } from '../common/ist-day';
import { Prisma } from '../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { notDeferredOn } from '../ticketing/deferral';
import { DAY_PLAN_NOTIFIER, DayPlanNotifier } from './day-plan-notifier';
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
  | { result: 'CONFLICT_ON_SITE'; ticketIds: string[]; seId: string };

export type AssignOutcome =
  | { result: 'OK'; scheduleId: string; batchId: string; ticketId: string; seId: string }
  | { result: 'NOT_FOUND' }
  | { result: 'ALREADY_ASSIGNED' };

/** Result of the multi-plant manual assign (Issue 122b): per-plant tallies + the overall totals. */
export interface PlantAssignSummary {
  seId: string;
  assigned: number;
  alreadyAssigned: number;
  perPlant: { plantId: string; assigned: number; openUnassigned: number }[];
}

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

    await this.audit.withAudit(
      this.auditEntry(actor, batchId, {
        action: cmd.action,
        ticketId: cmd.ticketId,
        reasonCode: cmd.reasonCode,
        seId,
      }, auditAction),
      async (tx) => {
        await tx.batchAssignmentTicket.update({
          where: { id: bat.id },
          data: { removedAt: now, removedBy: actor.userId },
        });
        // Returned to the Shared Pool — no longer a Formal Assignment.
        await tx.ticket.update({ where: { ticketId: cmd.ticketId }, data: { assignmentState: 'UNASSIGNED' } });
        await this.flagOverridden(tx, batchId, scheduleId, cmd.reasonCode, actor, now);
      },
    );

    await this.notifier.dayPlanOverridden({ seId, scheduleId, batchId, action: cmd.action });
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

    await this.audit.withAudit(
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
        await tx.batchAssignmentTicket.update({
          where: { id: bat.id },
          data: { deferredToDate: new Date(cmd.deferredToDate), removedAt: now, removedBy: actor.userId },
        });
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
      },
    );

    await this.notifier.dayPlanOverridden({ seId, scheduleId, batchId, action: cmd.action });
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

    await this.audit.withAudit(
      this.auditEntry(actor, batchId, { action: cmd.action, stopSequence: pos, reasonCode: cmd.reasonCode, seId }, auditAction),
      async (tx) => {
        for (let i = 0; i < ordered.length; i++) {
          await tx.plantBatchAssignment.update({
            where: { batchId: ordered[i].batchId },
            data: { stopSequence: i + 1 },
          });
        }
        await this.flagOverridden(tx, batchId, scheduleId, cmd.reasonCode, actor, now);
      },
    );

    await this.notifier.dayPlanOverridden({ seId, scheduleId, batchId, action: cmd.action });
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
  ): Promise<AssignOutcome> {
    const ticket = await this.prisma.ticket.findUnique({ where: { ticketId }, include: { plant: true } });
    if (!ticket || !this.inScope(ticket.plant.zoneId, scope)) return { result: 'NOT_FOUND' };
    if (ticket.assignmentState === 'FORMALLY_ASSIGNED') return { result: 'ALREADY_ASSIGNED' };
    const target = await this.prisma.engineerMaster.findUnique({ where: { engineerId: seId } });
    if (!target) return { result: 'NOT_FOUND' };

    // The **IST** calendar day (#240; CONTEXT.md Decisions §19) — `date_from`/`date_to` are `@db.Date`,
    // and a UTC-derived day put a 00:00–05:29 IST manual assign on *yesterday's* schedule: a different
    // row from the one `dispatchForZone` builds and the Day Plan reads for the same instant.
    const day = istDate(now);
    const ids = await this.audit.withAudit(
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
        const sched = await this.ensureSchedule(tx, seId, { zoneId: ticket.plant.zoneId, dateFrom: day, dateTo: day }, now);
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
          data: { batchId: batch.batchId, ticketId, sortOrder: await this.nextSortOrder(tx, batch.batchId) },
        });
        await tx.ticket.update({ where: { ticketId }, data: { assignmentState: 'FORMALLY_ASSIGNED' } });
        if (insertAtTop) await this.moveBatchToTop(tx, sched.scheduleId, batch.batchId);
        return { scheduleId: sched.scheduleId, batchId: batch.batchId };
      },
    );

    await this.notifier.dayPlanOverridden({ seId, scheduleId: ids.scheduleId, batchId: ids.batchId, action: auditAction });
    return { result: 'OK', scheduleId: String(ids.scheduleId), batchId: String(ids.batchId), ticketId, seId };
  }

  /**
   * Manual multi-plant SE assignment (Issue 122b, Device Detail page). For each selected plant, every
   * OPEN + UNASSIGNED ticket is formally assigned to the SE through the exact same {@link assignTicket}
   * primitive the Critical-Queue one-click and the ZM same-day ADD use — so schedules, plant batches,
   * stop ordering, audit rows, notifications and the Shared-Pool exit all behave identically to the
   * system flow. Zone scope is enforced per ticket inside assignTicket (out-of-scope plants contribute
   * nothing rather than failing the whole batch).
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
    const summary: PlantAssignSummary = { seId, assigned: 0, alreadyAssigned: 0, perPlant: [] };

    for (const plantId of ids) {
      const open = await this.prisma.ticket.findMany({
        // #146 — a bulk "assign this plant's open work to an SE" must not silently resurrect a ticket
        // another ZM deliberately deferred to a future date. The deferral is still an explicit human
        // decision; a ZM who wants it back today can re-assign that ticket directly.
        where: { plantId, status: 'OPEN', assignmentState: 'UNASSIGNED', ...notDeferredOn(istDate(now)) },
        select: { ticketId: true },
        orderBy: { createdAt: 'asc' },
      });
      let assigned = 0;
      for (const t of open) {
        const outcome = await this.assignTicket(t.ticketId, seId, scope, actor, now, 'MANUAL_PLANT_ASSIGN');
        if (outcome.result === 'OK') assigned += 1;
        else if (outcome.result === 'ALREADY_ASSIGNED') summary.alreadyAssigned += 1;
      }
      summary.assigned += assigned;
      summary.perPlant.push({ plantId: String(plantId), assigned, openUnassigned: open.length });
    }
    return summary;
  }

  private async swapSe(
    batch: BatchWithSchedule,
    cmd: Extract<OverrideCommand, { action: 'SWAP_SE' }>,
    actor: ActorContext,
    now: Date,
  ): Promise<OverrideOutcome> {
    const target = await this.prisma.engineerMaster.findUnique({ where: { engineerId: cmd.newSeId } });
    if (!target) return { result: 'NOT_FOUND' };

    const newScheduleId = await this.audit.withAudit(
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
        await tx.workSchedule.update({
          where: { scheduleId: batch.scheduleId },
          data: { status: 'OVERRIDDEN', lastOverriddenBy: actor.userId, lastOverriddenAt: now },
        });
        return sched.scheduleId;
      },
    );

    await this.notifier.dayPlanOverridden({ seId: cmd.newSeId, scheduleId: newScheduleId, batchId: batch.batchId, action: cmd.action });
    return { result: 'OK', batchId: String(batch.batchId), scheduleId: String(newScheduleId), seId: cmd.newSeId, status: 'OVERRIDDEN' };
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

    const newScheduleId = await this.audit.withAudit(
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
        for (const r of rows) {
          // Update (mark removed) before insert so the one-active-batch-per-ticket partial unique holds.
          await tx.batchAssignmentTicket.update({ where: { id: r.id }, data: { removedAt: now, removedBy: actor.userId } });
          await tx.batchAssignmentTicket.create({ data: { batchId: targetBatch.batchId, ticketId: r.ticketId, sortOrder: sort++ } });
        }
        await this.flagOverridden(tx, batch.batchId, batch.scheduleId, reasonCode, actor, now);
        return sched.scheduleId;
      },
    );

    await this.notifier.dayPlanOverridden({ seId: newSeId, scheduleId: newScheduleId, batchId: batch.batchId, action });
    return { result: 'OK', batchId: String(batch.batchId), scheduleId: String(batch.scheduleId), seId: batch.seId, status: 'OVERRIDDEN' };
  }

  /** Find the target SE's live schedule for the source date range, or create a ZM_MANUAL one. */
  private async ensureSchedule(
    tx: Prisma.TransactionClient,
    seId: string,
    source: { zoneId: bigint; dateFrom: Date; dateTo: Date },
    now: Date,
  ) {
    // #153 — the target SE's own plan may itself have been overridden earlier (a ZM commonly adjusts
    // several plans in one sitting). Matching ACTIVE only stacked a second ZM_MANUAL schedule on top of
    // the plan they were already working. Oldest-first, matching the dispatch APPEND path.
    const existing = await tx.workSchedule.findFirst({
      where: { seId, zoneId: source.zoneId, dateFrom: source.dateFrom, dateTo: source.dateTo, ...liveScheduleFilter() },
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
        source: 'ZM_MANUAL',
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
    await tx.workSchedule.update({
      where: { scheduleId },
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
