import { istDate } from '../common/ist-day';
import { CRITICAL_PLUS_BUCKETS } from '../device-state/sla-bucket';
import { notDeferredOn } from '../ticketing/deferral';
import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { Prisma } from '../generated/prisma/client';
import { type CompanyTier, type SlaBucket } from '../generated/prisma/enums';
import { NotificationService, type NotifyRecipient } from '../notifications/notification.service';
import { drainProducerRows, queueNotification } from '../scheduling/day-plan-notification-outbox';
import { ActorContext, OverrideService } from '../scheduling/override.service';
import { ZmScope } from '../scheduling/zm-schedule-query.service';
import { PrismaService } from '../prisma/prisma.service';

/** A Platinum Ticket unassigned this long in a CRITICAL+ bucket auto-escalates to the CSM queue. */
export const AUTO_CRITICAL_UNASSIGNED_MIN = 60;
/** A Platinum Ticket still OPEN+unassigned this long auto-escalates regardless of bucket. */
export const AUTO_OPEN_UNASSIGNED_MIN = 240;

const logger = new Logger('CrossZoneEscalationService');

/** The statuses that still want a decision — what the `/cross-zone` queue is for. */
const ACTIONABLE_STATUSES = ['PENDING', 'DEFERRED', 'ESCALATED_TO_OPS'] as const;


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
  /**
   * #354 (CZ-11) — which side of this escalation the reader is on. `outgoing` is work this zone sent
   * out (it is the home zone); `incoming` is work this zone has been given (it is the target zone).
   * `null` for a pan-India reader (CSM / Operations Head), for whom the row has no near side: the
   * queue they see is every zone's, and a direction relative to no zone would be an invention.
   */
  direction: 'incoming' | 'outgoing' | null;
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
  /**
   * #354 (CZ-13) — the two answers `approve` used to give as `NOT_FOUND`, which the controller then
   * reported as "escalation or SE not found". Neither is a miss: one names an engineer who does not
   * exist, the other a ticket held to a return date (#249), and an operator can act on each.
   */
  | { result: 'SE_NOT_FOUND' }
  | { result: 'TICKET_DEFERRED'; deferredUntil: string }
  /** `assignedSeId` names who holds it — the caller can see whether their own retry already won. */
  | { result: 'ALREADY_ASSIGNED'; assignedSeId?: string | null };

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
      //
      // #354 (#140) — and the loop itself is now per-ticket fallible. One ticket that cannot be
      // escalated used to abandon every ticket behind it in the sweep: the zone's remaining Platinum
      // work simply went unraised, on a scheduled tick nobody watches. The transaction above is what
      // makes carrying on safe — a failed ticket leaves *nothing* behind, so the
      // `crossZoneEscalations: { none: {} }` predicate still finds it on the next sweep rather than
      // treating a half-written row as "already escalated" and excluding it for ever.
      try {
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
      } catch (e: unknown) {
        // Logged rather than swallowed silently: a Platinum ticket that failed to escalate is the one
        // thing this sweep exists to prevent, so it must be visible even though the run continues.
        logger.error(`cross-zone auto-escalation failed for ticket ${t.ticketId}: ${(e as Error)?.message ?? e}`);
      }
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
    // CZ-13 — asked before the assignment so an unknown engineer is reported as one, rather than
    // arriving as `assignTicket`'s NOT_FOUND and being told to the operator as a missing escalation.
    const engineer = await this.prisma.engineerMaster.findUnique({ where: { engineerId: seId } });
    if (!engineer) return { result: 'SE_NOT_FOUND' };

    const scope: ZmScope = { role: actor.role, zoneId: actor.zoneId };

    // #354 (CZ-01) — the approval is ONE transaction. `assignTicket` used to commit the Formal
    // Assignment in its own transaction and this door then updated the escalation in another, so a
    // crash in the gap left a ticket assigned to a target-zone SE beside an escalation still reading
    // PENDING — and the retry that should have repaired it short-circuited on `ALREADY_ASSIGNED`
    // instead (#139), leaving the queue permanently disagreeing with the schedule.
    //
    // #325's `inTransaction` hook is the seam: it runs last inside the assignment's own transaction,
    // against ids that are final, and a throw from it takes the assignment down with it. So the
    // escalation row, its audit row and both zones' notices now live or die with the assignment they
    // describe. The hook may run twice (it sits inside `retryOnceOnUniqueViolation`); re-assigning
    // `outboxIds` each time is correct, because the losing attempt committed nothing.
    let outboxIds: (bigint | null)[] = [];
    const assigned = await this.override.assignTicket(
      esc.ticketId,
      seId,
      scope,
      actor,
      now,
      'CROSS_ZONE_ASSIGN',
      false,
      {},
      null,
      async (tx, ids) => {
        outboxIds = await this.writeApproval(tx, {
          escalationId,
          homeZoneId: esc.homeZoneId,
          ticketId: esc.ticketId,
          targetZoneId,
          seId,
          scheduleId: ids.scheduleId,
          batchId: ids.batchId,
          actor,
          now,
        });
      },
    );

    if (assigned.result === 'ALREADY_ASSIGNED') return this.reconcileApproved(esc, escalationId, targetZoneId, seId, actor, now);
    if (assigned.result === 'CONFLICT_DEFERRED') return { result: 'TICKET_DEFERRED', deferredUntil: assigned.deferredUntil };
    if (assigned.result !== 'OK') return { result: 'NOT_FOUND' };

    await this.deliverAll(outboxIds, now);
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

  /**
   * The `/cross-zone` queue read — actionable rows (CSM/OH cross-zone; a ZM sees their own zone).
   *
   * #354 (CZ-11) — "their own zone" now means **both sides**. A ZM was scoped by `homeZoneId` alone,
   * so the zone that had to do a piece of cross-zone work could not see it anywhere: the approval put
   * a ticket on one of their engineers and their queue showed nothing. The incoming arm therefore also
   * carries APPROVED rows, because for the receiving zone the approval is not the end of the story —
   * it is the beginning of it. The outgoing arm keeps the actionable statuses it always had: a decided
   * escalation is no longer the home zone's to act on.
   */
  async listForScope(scope: { role: string; zoneId: number | null }): Promise<CrossZoneEscalationRow[]> {
    const zmZoneId = scope.role === 'ZONAL_MANAGER' && scope.zoneId != null ? BigInt(scope.zoneId) : null;
    const where: Prisma.CrossZoneEscalationWhereInput =
      zmZoneId === null
        ? { status: { in: [...ACTIONABLE_STATUSES] } }
        : {
            OR: [
              { homeZoneId: zmZoneId, status: { in: [...ACTIONABLE_STATUSES] } },
              { targetZoneId: zmZoneId, status: { in: [...ACTIONABLE_STATUSES, 'APPROVED'] } },
            ],
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
      direction:
        zmZoneId === null ? null : r.homeZoneId === zmZoneId ? 'outgoing' : r.targetZoneId === zmZoneId ? 'incoming' : null,
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

  /**
   * The approval's own writes — the escalation row, its audit row, and the notice to each zone —
   * written on whatever transaction the caller hands in. That is the assignment's transaction on the
   * happy path (#325's hook) and a local one when reconciling an assignment that already committed.
   *
   * Returns the outbox row ids for the caller's post-commit drain (#338).
   */
  private async writeApproval(
    tx: Prisma.TransactionClient,
    a: {
      escalationId: bigint;
      homeZoneId: bigint;
      ticketId: string;
      targetZoneId: number;
      seId: string;
      scheduleId: bigint;
      batchId: bigint;
      actor: CrossZoneActor;
      now: Date;
    },
  ): Promise<(bigint | null)[]> {
    await tx.crossZoneEscalation.update({
      where: { escalationId: a.escalationId },
      data: {
        status: 'APPROVED',
        targetZoneId: BigInt(a.targetZoneId),
        assignedSeId: a.seId,
        assignedScheduleId: a.scheduleId,
        assignedBatchId: a.batchId,
        decidedByUserId: a.actor.userId,
        decidedByRole: a.actor.role,
        decidedAt: a.now,
      },
    });
    await this.auditEscalation(
      tx,
      'CROSS_ZONE_APPROVE',
      a.escalationId,
      a.ticketId,
      { targetZoneId: a.targetZoneId, seId: a.seId },
      a.actor,
      a.now,
    );
    const home = await this.notifyHomeZm(
      tx,
      a.homeZoneId,
      a.ticketId,
      a.escalationId,
      'APPROVED',
      `Assigned cross-zone to SE in zone ${a.targetZoneId}.`,
    );
    // #354 (CZ-11) — the zone that has to DO the work is told. Approving moved a ticket onto a
    // target-zone SE's Day Plan and the only person notified was the home ZM, who is losing the work,
    // not doing it: the target ZM found out when their engineer's day already had it on.
    const target = await this.notifyTargetZm(tx, BigInt(a.targetZoneId), a.homeZoneId, a.ticketId, a.escalationId, a.seId);
    return [home, target];
  }

  /**
   * #354 (#139) — the retry that used to be impossible.
   *
   * `ALREADY_ASSIGNED` means somebody got there first, and the somebody is usually **this door's own
   * earlier attempt**: pre-#354 the assignment committed and the escalation update did not, so every
   * later attempt hit the assignment it had itself made and returned a conflict, for ever. When the
   * live assignment is to the very engineer being approved, there is nothing to conflict over — the
   * world already holds the outcome the operator is asking for, and the escalation row is simply
   * behind. Reconcile it, from the live assignment rather than from anything remembered.
   *
   * A *different* engineer is a genuine conflict and stays one; the outcome now names who holds it.
   */
  private async reconcileApproved(
    esc: { ticketId: string; homeZoneId: bigint },
    escalationId: bigint,
    targetZoneId: number,
    seId: string,
    actor: CrossZoneActor,
    now: Date,
  ): Promise<DecisionOutcome> {
    const live = await this.prisma.batchAssignmentTicket.findFirst({
      where: { ticketId: esc.ticketId, removedAt: null },
      orderBy: { id: 'desc' },
      include: { batch: { select: { batchId: true, scheduleId: true, seId: true } } },
    });
    if (!live || live.batch.seId !== seId) return { result: 'ALREADY_ASSIGNED', assignedSeId: live?.batch.seId ?? null };

    const outboxIds = await this.prisma.$transaction((tx) =>
      this.writeApproval(tx, {
        escalationId,
        homeZoneId: esc.homeZoneId,
        ticketId: esc.ticketId,
        targetZoneId,
        seId,
        scheduleId: live.batch.scheduleId,
        batchId: live.batch.batchId,
        actor,
        now,
      }),
    );
    await this.deliverAll(outboxIds, now);
    return { result: 'OK', escalationId: String(escalationId), status: 'APPROVED' };
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

  /**
   * #354 (CZ-09) — who a zone's escalation news goes to.
   *
   * The designated `zones.zonal_manager_user_id` when there is one: that is the accountable manager,
   * and a zone that names one does not want its news fanned out to everybody who happens to hold the
   * role there. When there is none — a zone between managers, or one never linked — the role itself
   * answers, and if *that* is empty {@link NotificationService.recipientsInRoles} logs the miss. The
   * one thing this must never do is what it used to: return nothing, quietly.
   */
  private async zoneManagers(tx: Prisma.TransactionClient, zoneId: bigint): Promise<NotifyRecipient[]> {
    const zone = await tx.zone.findUnique({ where: { zoneId } });
    if (zone?.zonalManagerUserId) return [{ userId: zone.zonalManagerUserId, role: 'ZONAL_MANAGER' }];
    return this.notifications.recipientsInRoles({ role: 'ZONAL_MANAGER', zoneId }, tx);
  }

  /** #338 — queued in the caller's transaction; null when the home zone has nobody to tell (logged). */
  private async notifyHomeZm(
    tx: Prisma.TransactionClient,
    homeZoneId: bigint,
    ticketId: string,
    escalationId: bigint,
    decision: string,
    reason: string,
  ): Promise<bigint | null> {
    const recipients = await this.zoneManagers(tx, homeZoneId);
    if (recipients.length === 0) return null;
    return queueNotification(tx, {
      recipients,
      type: 'CROSS_ZONE_DECISION',
      title: `Cross-zone escalation ${decision.toLowerCase()}`,
      body: `Ticket ${ticketId}: ${decision}. ${reason}`,
      entityType: 'ticket',
      entityId: ticketId,
      deliveryModel: 'GENERAL',
      metadata: { escalationId: String(escalationId), ticketId, decision, reason },
    });
  }

  /**
   * #354 (CZ-11) — the target zone's own notice: work has been put on one of your engineers.
   *
   * A separate type from `CROSS_ZONE_DECISION` because it is a different fact for a different reader:
   * the home ZM is told what happened to their request, the target ZM is told what has landed on their
   * plan. Same transaction as the assignment, so it cannot be told about work that did not commit.
   */
  private async notifyTargetZm(
    tx: Prisma.TransactionClient,
    targetZoneId: bigint,
    homeZoneId: bigint,
    ticketId: string,
    escalationId: bigint,
    seId: string,
  ): Promise<bigint | null> {
    const recipients = await this.zoneManagers(tx, targetZoneId);
    if (recipients.length === 0) return null;
    return queueNotification(tx, {
      recipients,
      type: 'CROSS_ZONE_INCOMING',
      title: 'Incoming cross-zone work',
      body: `Ticket ${ticketId} from zone ${homeZoneId} is assigned to one of your engineers.`,
      entityType: 'ticket',
      entityId: ticketId,
      deliveryModel: 'GENERAL',
      metadata: { escalationId: String(escalationId), ticketId, homeZoneId: String(homeZoneId), seId },
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

  /** The same post-commit drain for a door that wrote more than one notice (approve tells both zones). */
  private deliverAll(outboxIds: (bigint | null)[], now: Date): Promise<void> {
    return drainProducerRows(
      this.prisma,
      { notify: this.notifications },
      outboxIds.filter((id): id is bigint => id !== null),
      now,
    );
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
        actingZone: actor?.actingZone != null ? BigInt(actor.actingZone) : null,
        action,
        entityType: 'cross_zone_escalation',
        entityId: String(escalationId),
        metadata: { ticketId, ...metadata } as Prisma.InputJsonValue,
      },
    });
  }
}
