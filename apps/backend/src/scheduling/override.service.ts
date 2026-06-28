import { Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { DAY_PLAN_NOTIFIER, DayPlanNotifier } from './day-plan-notifier';
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
        await tx.batchAssignmentTicket.update({
          where: { id: bat.id },
          data: { deferredToDate: new Date(cmd.deferredToDate) },
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

    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
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

  /** Find the target SE's ACTIVE schedule for the source date range, or create a ZM_MANUAL one. */
  private async ensureSchedule(
    tx: Prisma.TransactionClient,
    seId: string,
    source: { zoneId: bigint; dateFrom: Date; dateTo: Date },
    now: Date,
  ) {
    const existing = await tx.workSchedule.findFirst({
      where: { seId, zoneId: source.zoneId, status: 'ACTIVE', dateFrom: source.dateFrom, dateTo: source.dateTo },
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
