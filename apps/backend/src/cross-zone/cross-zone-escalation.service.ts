import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { Prisma } from '../generated/prisma/client';
import { type CompanyTier, type SlaBucket } from '../generated/prisma/enums';
import { NotificationService } from '../notifications/notification.service';
import { ActorContext, OverrideService } from '../scheduling/override.service';
import { ZmScope } from '../scheduling/zm-schedule-query.service';
import { PrismaService } from '../prisma/prisma.service';

/** A Platinum Ticket unassigned this long in a CRITICAL+ bucket auto-escalates to the CSM queue. */
export const AUTO_CRITICAL_UNASSIGNED_MIN = 60;
/** A Platinum Ticket still OPEN+unassigned this long auto-escalates regardless of bucket. */
export const AUTO_OPEN_UNASSIGNED_MIN = 240;

/** CRITICAL and more severe buckets (CONTEXT severity order). */
const CRITICAL_PLUS: SlaBucket[] = ['CRITICAL', 'HIGH_CRITICAL', 'SEVERE', 'VERY_SEVERE', 'LONG_PENDING'];

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
        (bucket !== null && CRITICAL_PLUS.includes(bucket) && ageMin >= AUTO_CRITICAL_UNASSIGNED_MIN) ||
        ageMin >= AUTO_OPEN_UNASSIGNED_MIN;
      if (!qualifies) continue;

      const esc = await this.prisma.crossZoneEscalation.create({
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
      await this.auditEscalation('CROSS_ZONE_AUTO_ESCALATION', esc.escalationId, t.ticketId, {
        homeZoneId: String(t.plant.zoneId),
        triggerBucket: bucket,
      });
      await this.notifyCrossZoneQueue(t.ticketId, esc.escalationId, 'AUTO_PLATINUM', t.plant.zoneId);
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

    const esc = await this.prisma.crossZoneEscalation.create({
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
    await this.auditEscalation('CROSS_ZONE_MANUAL_FLAG', esc.escalationId, ticketId, { reason }, actor, now);
    await this.notifyCrossZoneQueue(ticketId, esc.escalationId, 'MANUAL_FLAG', ticket.plant.zoneId);
    return { result: 'OK', escalationId: String(esc.escalationId) };
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

    await this.prisma.crossZoneEscalation.update({
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
    await this.auditEscalation('CROSS_ZONE_APPROVE', escalationId, esc.ticketId, { targetZoneId, seId }, actor, now);
    await this.notifyHomeZm(esc.homeZoneId, esc.ticketId, escalationId, 'APPROVED', `Assigned cross-zone to SE in zone ${targetZoneId}.`);
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

    await this.prisma.crossZoneEscalation.update({
      where: { escalationId },
      data: { status: 'ESCALATED_TO_OPS', decidedByUserId: actor.userId, decidedByRole: actor.role, decidedAt: now },
    });
    await this.auditEscalation('CROSS_ZONE_RE_ESCALATE_OPS', escalationId, esc.ticketId, {}, actor, now);
    await this.notifyRole('OPERATIONS_HEAD', {
      type: 'CROSS_ZONE_RE_ESCALATED',
      title: 'Cross-zone escalation raised to you',
      body: `Denied Platinum cross-zone escalation for ticket ${esc.ticketId} re-escalated by the home ZM.`,
      ticketId: esc.ticketId,
      metadata: { escalationId: String(escalationId), ticketId: esc.ticketId },
    });
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

    await this.prisma.crossZoneEscalation.update({
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
    await this.auditEscalation(`CROSS_ZONE_${status}`, escalationId, esc.ticketId, { reason }, actor, now);
    await this.notifyHomeZm(esc.homeZoneId, esc.ticketId, escalationId, status, reason);
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

  private async notifyCrossZoneQueue(
    ticketId: string,
    escalationId: bigint,
    type: 'AUTO_PLATINUM' | 'MANUAL_FLAG',
    homeZoneId: bigint,
  ): Promise<void> {
    const recipients = await this.usersInRoles(['CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD']);
    if (recipients.length === 0) return;
    await this.notifications.notify({
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

  private async notifyHomeZm(
    homeZoneId: bigint,
    ticketId: string,
    escalationId: bigint,
    decision: string,
    reason: string,
  ): Promise<void> {
    const zone = await this.prisma.zone.findUnique({ where: { zoneId: homeZoneId } });
    if (!zone?.zonalManagerUserId) return;
    await this.notifications.notify({
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

  private async notifyRole(
    role: 'OPERATIONS_HEAD' | 'CENTRAL_SERVICE_MANAGER',
    n: { type: string; title: string; body: string; ticketId: string; metadata: Record<string, unknown> },
  ): Promise<void> {
    const recipients = await this.usersInRoles([role]);
    if (recipients.length === 0) return;
    await this.notifications.notify({
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

  private async usersInRoles(roles: ('CENTRAL_SERVICE_MANAGER' | 'OPERATIONS_HEAD')[]) {
    const users = await this.prisma.user.findMany({
      where: { role: { in: roles }, status: 'ACTIVE' },
      select: { userId: true, role: true },
    });
    return users.map((u) => ({ userId: u.userId, role: u.role }));
  }

  private async auditEscalation(
    action: string,
    escalationId: bigint,
    ticketId: string,
    metadata: Record<string, unknown>,
    actor?: CrossZoneActor,
    _now?: Date,
  ): Promise<void> {
    await this.prisma.auditLog.create({
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
