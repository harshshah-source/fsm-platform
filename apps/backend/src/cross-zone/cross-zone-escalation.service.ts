import { istDate } from '../common/ist-day';
import { CRITICAL_PLUS_BUCKETS } from '../device-state/sla-bucket';
import { notDeferredOn } from '../ticketing/deferral';
import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { Prisma } from '../generated/prisma/client';
import { type CompanyTier, type SlaBucket } from '../generated/prisma/enums';
import { NotificationService } from '../notifications/notification.service';
import { drainProducerRows, queueNotification } from '../scheduling/day-plan-notification-outbox';
import { ActorContext, OverrideService } from '../scheduling/override.service';
import { ZmScope } from '../scheduling/zm-schedule-query.service';
import { PrismaService } from '../prisma/prisma.service';

/** A Platinum Ticket unassigned this long in a CRITICAL+ bucket auto-escalates to the CSM queue. */
export const AUTO_CRITICAL_UNASSIGNED_MIN = 60;
/** A Platinum Ticket still OPEN+unassigned this long auto-escalates regardless of bucket. */
export const AUTO_OPEN_UNASSIGNED_MIN = 240;


export interface CrossZoneActor extends ActorContext {
  zoneId: number | null;
}

export interface CrossZoneEscalationRow {
  escalationId: string;
  ticketId: string;
  homeZoneId: string;
  companyId: string;
  companyTier: CompanyTier;
  escalationType: 'AUTO_PLATINUM' | 'MANUAL_FLAG';
  status: string;
  triggerBucket: SlaBucket | null;
  flagReason: string | null;
  decisionReason: string | null;
  reviewDate: string | null;
  targetZoneId: string | null;
  assignedSeId: string | null;
  raisedByRole: string | null;
  createdAt: string;
}

export type FlagOutcome =
  | { result: 'OK'; escalationId: string }
  | { result: 'NOT_FOUND' }
  | { result: 'FORBIDDEN_SCOPE' }
  | { result: 'FORBIDDEN_TIER' }
  | { result: 'ALREADY_ESCALATED' };

export type DecisionOutcome =
  | { result: 'OK'; escalationId: string; status: string }
  | { result: 'NOT_FOUND' }
  | { result: 'NOT_PENDING'; status: string }
  | { result: 'FORBIDDEN_SCOPE' }
  | { result: 'NOT_DENIED_AUTO' }
  | { result: 'ALREADY_ASSIGNED' };

/**
 * Cross-zone capacity allocation (CONTEXT cross-zone CSM layer, Issue 32). `sweepAutoEscalations` raises a
 * Platinum Ticket that's gone uncovered in its home zone to the CSM cross-zone queue; `flag` lets a ZM
 * push a Gold/Silver Ticket there manually. The CSM / Operations Head resolves each via `approve`
 * (cross-zone Formal Assignment), `deny` (reason — the Ticket stays in its home queue) or `defer`; a
 * denied AUTO escalation can be `reEscalateToOps`-ed by the home ZM. The Ticket is never removed from its
 * home queue — this is a parallel decision record, not a Ticket state change.
 */
@Injectable()
export class CrossZoneEscalationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly override: OverrideService,
    private readonly notifications: NotificationService,
    private readonly audit: AuditService = new AuditService(prisma),
  ) {}

  /** Auto-escalation sweep — Platinum OPEN/UNASSIGNED Tickets past the threshold, one escalation per Ticket. */
  async sweepAutoEscalations(now: Date = new Date(), zoneId?: bigint): Promise<{ escalated: number }> {
    const tickets = await this.prisma.ticket.findMany({
      where: {
        companyTier: 'PLATINUM',
        status: 'OPEN',
        assignmentState: 'UNASSIGNED',
        // #146 — a deferred ticket has a ZM-chosen return date; it is not "unassigned and rotting",
        // so it must not trip the Platinum auto-escalation clock while the deferral is still running.
        ...notDeferredOn(istDate(now)),
        crossZoneEscalations: { none: {} },
        ...(zoneId != null ? { plant: { zoneId } } : {}),
      },
      include: { plant: true, device: { select: { state: true } } },
    });

    let escalated = 0;
    for (const t of tickets) {
      const anchor = t.lastStateChangedAt ?? t.createdAt;
      const ageMin = (now.getTime() - anchor.getTime()) / 60_000;
      const bucket = t.device.state?.slaBucket ?? null;
      const qualifies =
        (bucket !== null && CRITICAL_PLUS_BUCKETS.includes(bucket) && ageMin >= AUTO_CRITICAL_UNASSIGNED_MIN) ||
        ageMin >= AUTO_OPEN_UNASSIGNED_MIN;
      if (!qualifies) continue;

      // #338 (survey CZ-02) — the escalation, its audit row and the notice that the queue has a new
      // item were three bare awaits. A crash between them left a PENDING Platinum escalation nobody
      // had been told about: a ticket waiting in a queue no CSM or OH was asked to look at.
      const outboxId = await this.prisma.$transaction(async (tx) => {
        const esc = await tx.crossZoneEscalation.create({
          data: {
            ticketId: t.ticketId,
            homeZoneId: t.plant.zoneId,
            companyTier: 'PLATINUM',
            escalationType: 'AUTO_PLATINUM',
            status: 'PENDING',
            triggerBucket: bucket,
            raisedByRole: 'SYSTEM',
          },
        });
        await this.auditEscalation(tx, 'CROSS_ZONE_AUTO_ESCALATION', esc.escalationId, t.ticketId, {
          homeZoneId: String(t.plant.zoneId),
          triggerBucket: bucket,
        });
        return this.notifyCrossZoneQueue(tx, t.ticketId, esc.escalationId, 'AUTO_PLATINUM', t.plant.zoneId);
      });
      // Per ticket, not per sweep: a push that fails must not hold up the zone's remaining work, and
      // `drainProducerRows` swallows its own failures for exactly that reason.
      await this.deliver(outboxId, now);
      escalated++;
    }
    return { escalated };
  }

  /** ZM manually flags a Gold/Silver Ticket in their own zone for cross-zone escalation (with a reason). */
  async flag(ticketId: string, reason: string, actor: CrossZoneActor, now: Date = new Date()): Promise<FlagOutcome> {
    const ticket = await this.prisma.ticket.findUnique({ where: { ticketId }, include: { plant: true } });
    if (!ticket) return { result: 'NOT_FOUND' };
    if (!this.zmOwnsZone(ticket.plant.zoneId, actor)) return { result: 'FORBIDDEN_SCOPE' };
    // Platinum uses the auto path; the manual flag is the Gold/Silver lever.
    if (ticket.companyTier === 'PLATINUM') return { result: 'FORBIDDEN_TIER' };
    const active = await this.prisma.crossZoneEscalation.findFirst({
      where: { ticketId, status: { in: ['PENDING', 'DEFERRED'] } },
    });
    if (active) return { result: 'ALREADY_ESCALATED' };

    const flagged = await this.prisma.$transaction(async (tx) => {
      const esc = await tx.crossZoneEscalation.create({
        data: {
          ticketId,
          homeZoneId: ticket.plant.zoneId,
          companyTier: ticket.companyTier,
          escalationType: 'MANUAL_FLAG',
          status: 'PENDING',
          flagReason: reason,
          raisedByUserId: actor.userId,
          raisedByRole: actor.role,
        },
      });
      await this.auditEscalation(tx, 'CROSS_ZONE_MANUAL_FLAG', esc.escalationId, ticketId, { reason }, actor, now);
      const outboxId = await this.notifyCrossZoneQueue(tx, ticketId, esc.escalationId, 'MANUAL_FLAG', ticket.plant.zoneId);
      return { escalationId: esc.escalationId, outboxId };
    });
    await this.deliver(flagged.outboxId, now);
    return { result: 'OK', escalationId: String(flagged.escalationId) };
  }

  /** CSM/OH approves — commits a cross-zone Formal Assignment to the chosen target-zone SE. */
  async approve(
    escalationId: bigint,
    targetZoneId: number,
    seId: string,
    actor: CrossZoneActor,
    now: Date = new Date(),
  ): Promise<DecisionOutcome> {
    const esc = await this.prisma.crossZoneEscalation.findUnique({ where: { escalationId } });
    if (!esc) return { result: 'NOT_FOUND' };
    if (!this.isOpen(esc.status)) return { result: 'NOT_PENDING', status: esc.status };

    const scope: ZmScope = { role: actor.role, zoneId: actor.zoneId };
    const assigned = await this.override.assignTicket(esc.ticketId, seId, scope, actor, now, 'CROSS_ZONE_ASSIGN');
    if (assigned.result === 'ALREADY_ASSIGNED') return { result: 'ALREADY_ASSIGNED' };
    if (assigned.result !== 'OK') return { result: 'NOT_FOUND' };

    // #338 — this door's OWN writes (the escalation update, its audit row and the home ZM's notice)
    // now commit together. What is deliberately NOT fixed here is CZ-01: `assignTicket` above ran in
    // its own transaction, so an approval can still leave an assigned ticket beside an un-updated
    // escalation. That is a cross-service atomicity problem and it belongs to #354.
    const outboxId = await this.prisma.$transaction(async (tx) => {
      await tx.crossZoneEscalation.update({
        where: { escalationId },
        data: {
          status: 'APPROVED',
          targetZoneId: BigInt(targetZoneId),
          assignedSeId: seId,
          assignedScheduleId: BigInt(assigned.scheduleId),
          assignedBatchId: BigInt(assigned.batchId),
          decidedByUserId: actor.userId,
          decidedByRole: actor.role,
          decidedAt: now,
        },
      });
      await this.auditEscalation(tx, 'CROSS_ZONE_APPROVE', escalationId, esc.ticketId, { targetZoneId, seId }, actor, now);
      return this.notifyHomeZm(
        tx,
        esc.homeZoneId,
        esc.ticketId,
        escalationId,
        'APPROVED',
        `Assigned cross-zone to SE in zone ${targetZoneId}.`,
      );
    });
    await this.deliver(outboxId, now);
    return { result: 'OK', escalationId: String(escalationId), status: 'APPROVED' };
  }

  /** CSM/OH denies (mandatory reason) — the Ticket stays in its home queue. */
  async deny(escalationId: bigint, reason: string, actor: CrossZoneActor, now: Date = new Date()): Promise<DecisionOutcome> {
    return this.decide(escalationId, 'DENIED', reason, null, actor, now);
  }

  /** CSM/OH defers to a review date (mandatory reason). */
  async defer(
    escalationId: bigint,
    reviewDate: Date,
    reason: string,
    actor: CrossZoneActor,
    now: Date = new Date(),
  ): Promise<DecisionOutcome> {
    return this.decide(escalationId, 'DEFERRED', reason, reviewDate, actor, now);
  }

  /** Home ZM re-escalates a DENIED AUTO escalation up to Operations Head. */
  async reEscalateToOps(escalationId: bigint, actor: CrossZoneActor, now: Date = new Date()): Promise<DecisionOutcome> {
    const esc = await this.prisma.crossZoneEscalation.findUnique({ where: { escalationId } });
    if (!esc) return { result: 'NOT_FOUND' };
    if (esc.status !== 'DENIED' || esc.escalationType !== 'AUTO_PLATINUM') return { result: 'NOT_DENIED_AUTO' };
    if (!this.zmOwnsZone(esc.homeZoneId, actor)) return { result: 'FORBIDDEN_SCOPE' };

    const outboxId = await this.prisma.$transaction(async (tx) => {
      await tx.crossZoneEscalation.update({
        where: { escalationId },
        data: { status: 'ESCALATED_TO_OPS', decidedByUserId: actor.userId, decidedByRole: actor.role, decidedAt: now },
      });
      await this.auditEscalation(tx, 'CROSS_ZONE_RE_ESCALATE_OPS', escalationId, esc.ticketId, {}, actor, now);
      return this.notifyRole(tx, 'OPERATIONS_HEAD', {
        type: 'CROSS_ZONE_RE_ESCALATED',
        title: 'Cross-zone escalation raised to you',
        body: `Denied Platinum cross-zone escalation for ticket ${esc.ticketId} re-escalated by the home ZM.`,
        ticketId: esc.ticketId,
        metadata: { escalationId: String(escalationId), ticketId: esc.ticketId },
      });
    });
    await this.deliver(outboxId, now);
    return { result: 'OK', escalationId: String(escalationId), status: 'ESCALATED_TO_OPS' };
  }

  /** The `/cross-zone` queue read — actionable rows (CSM/OH cross-zone; a ZM sees their home zone only). */
  async listForScope(scope: { role: string; zoneId: number | null }): Promise<CrossZoneEscalationRow[]> {
    const where: Prisma.CrossZoneEscalationWhereInput = {
      status: { in: ['PENDING', 'DEFERRED', 'ESCALATED_TO_OPS'] },
      ...(scope.role === 'ZONAL_MANAGER' && scope.zoneId != null ? { homeZoneId: BigInt(scope.zoneId) } : {}),
    };
    const rows = await this.prisma.crossZoneEscalation.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { ticket: { select: { companyId: true } } },
    });
    return rows.map((r) => ({
      escalationId: String(r.escalationId),
      ticketId: r.ticketId,
      homeZoneId: String(r.homeZoneId),
      companyId: String(r.ticket.companyId),
      companyTier: r.companyTier,
      escalationType: r.escalationType,
      status: r.status,
      triggerBucket: r.triggerBucket,
      flagReason: r.flagReason,
      decisionReason: r.decisionReason,
      reviewDate: r.reviewDate ? r.reviewDate.toISOString() : null,
      targetZoneId: r.targetZoneId != null ? String(r.targetZoneId) : null,
      assignedSeId: r.assignedSeId,
      raisedByRole: r.raisedByRole,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  // ---- internals ---------------------------------------------------------

  private async decide(
    escalationId: bigint,
    status: 'DENIED' | 'DEFERRED',
    reason: string,
    reviewDate: Date | null,
    actor: CrossZoneActor,
    now: Date,
  ): Promise<DecisionOutcome> {
    const esc = await this.prisma.crossZoneEscalation.findUnique({ where: { escalationId } });
    if (!esc) return { result: 'NOT_FOUND' };
    if (!this.isOpen(esc.status)) return { result: 'NOT_PENDING', status: esc.status };

    // #338 — a decision the home ZM was never told about is the state this door must not be able to
    // leave behind: the escalation reads DENIED to everyone but the person whose queue it came from.
    const outboxId = await this.prisma.$transaction(async (tx) => {
      await tx.crossZoneEscalation.update({
        where: { escalationId },
        data: {
          status,
          decisionReason: reason,
          reviewDate: reviewDate ?? null,
          decidedByUserId: actor.userId,
          decidedByRole: actor.role,
          decidedAt: now,
        },
      });
      await this.auditEscalation(tx, `CROSS_ZONE_${status}`, escalationId, esc.ticketId, { reason }, actor, now);
      return this.notifyHomeZm(tx, esc.homeZoneId, esc.ticketId, escalationId, status, reason);
    });
    await this.deliver(outboxId, now);
    return { result: 'OK', escalationId: String(escalationId), status };
  }

  private isOpen(status: string): boolean {
    return status === 'PENDING' || status === 'DEFERRED';
  }

  private zmOwnsZone(homeZoneId: bigint, actor: CrossZoneActor): boolean {
    const effective = actor.actedAsRole ?? actor.role;
    if (effective !== 'ZONAL_MANAGER') return effective === 'CENTRAL_SERVICE_MANAGER' || effective === 'OPERATIONS_HEAD';
    return actor.zoneId != null && BigInt(actor.zoneId) === homeZoneId;
  }

  /**
   * #338 — queued inside the caller's transaction, so the queue item and the notice that it exists
   * cannot disagree. Returns the outbox row id, or null when there is nobody in the roles to tell.
   *
   * The recipients are resolved HERE, in the producing transaction, and recorded in the row. That is
   * the point of the resolved-payload shape: a row that says who it was for can answer "who was
   * told" afterwards, which a row that re-derives its recipients at delivery time cannot.
   */
  private async notifyCrossZoneQueue(
    tx: Prisma.TransactionClient,
    ticketId: string,
    escalationId: bigint,
    type: 'AUTO_PLATINUM' | 'MANUAL_FLAG',
    homeZoneId: bigint,
  ): Promise<bigint | null> {
    const recipients = await this.usersInRoles(['CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'], tx);
    if (recipients.length === 0) return null;
    return queueNotification(tx, {
      recipients,
      type: type === 'AUTO_PLATINUM' ? 'CROSS_ZONE_AUTO_ESCALATION' : 'CROSS_ZONE_MANUAL_FLAG',
      title: type === 'AUTO_PLATINUM' ? 'Platinum cross-zone escalation' : 'Cross-zone flag raised',
      body: `Ticket ${ticketId} needs cross-zone coverage (home zone ${homeZoneId}).`,
      entityType: 'ticket',
      entityId: ticketId,
      deliveryModel: 'GENERAL',
      metadata: { escalationId: String(escalationId), ticketId, escalationType: type },
    });
  }

  /** #338 — queued in the caller's transaction; null when the home zone has no ZM to tell. */
  private async notifyHomeZm(
    tx: Prisma.TransactionClient,
    homeZoneId: bigint,
    ticketId: string,
    escalationId: bigint,
    decision: string,
    reason: string,
  ): Promise<bigint | null> {
    const zone = await tx.zone.findUnique({ where: { zoneId: homeZoneId } });
    if (!zone?.zonalManagerUserId) return null;
    return queueNotification(tx, {
      recipients: [{ userId: zone.zonalManagerUserId, role: 'ZONAL_MANAGER' }],
      type: 'CROSS_ZONE_DECISION',
      title: `Cross-zone escalation ${decision.toLowerCase()}`,
      body: `Ticket ${ticketId}: ${decision}. ${reason}`,
      entityType: 'ticket',
      entityId: ticketId,
      deliveryModel: 'GENERAL',
      metadata: { escalationId: String(escalationId), ticketId, decision, reason },
    });
  }

  /** #338 — queued in the caller's transaction; null when nobody holds the role. */
  private async notifyRole(
    tx: Prisma.TransactionClient,
    role: 'OPERATIONS_HEAD' | 'CENTRAL_SERVICE_MANAGER',
    n: { type: string; title: string; body: string; ticketId: string; metadata: Record<string, unknown> },
  ): Promise<bigint | null> {
    const recipients = await this.usersInRoles([role], tx);
    if (recipients.length === 0) return null;
    return queueNotification(tx, {
      recipients,
      type: n.type,
      title: n.title,
      body: n.body,
      entityType: 'ticket',
      entityId: n.ticketId,
      deliveryModel: 'GENERAL',
      metadata: n.metadata,
    });
  }

  /**
   * The post-commit half (#338): attempt delivery of the row this door just wrote, if it wrote one.
   * A failure never reaches the caller — {@link drainProducerRows} un-claims the row for the sweep,
   * which is what stops one unreachable manager from aborting a decision that already committed.
   */
  private deliver(outboxId: bigint | null, now: Date): Promise<void> {
    return drainProducerRows(this.prisma, { notify: this.notifications }, outboxId === null ? [] : [outboxId], now);
  }

  private async usersInRoles(
    roles: ('CENTRAL_SERVICE_MANAGER' | 'OPERATIONS_HEAD')[],
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    const users = await client.user.findMany({
      where: { role: { in: roles }, status: 'ACTIVE' },
      select: { userId: true, role: true },
    });
    return users.map((u) => ({ userId: u.userId, role: u.role }));
  }

  /** #338 — writes on the caller's transaction, so the audit row and the escalation it describes
   *  can no longer be two separate commits with a crash in between. */
  private async auditEscalation(
    tx: Prisma.TransactionClient,
    action: string,
    escalationId: bigint,
    ticketId: string,
    metadata: Record<string, unknown>,
    actor?: CrossZoneActor,
    _now?: Date,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        actorId: actor?.userId ?? '00000000-0000-0000-0000-000000000000',
        actorRole: actor?.role ?? 'SYSTEM',
        actedAsRole: actor?.actedAsRole ?? null,
        action,
        entityType: 'cross_zone_escalation',
        entityId: String(escalationId),
        metadata: { ticketId, ...metadata } as Prisma.InputJsonValue,
      },
    });
  }
}
