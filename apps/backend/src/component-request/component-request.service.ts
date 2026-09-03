import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { type ComponentRequestStatus, type CoverageType, type DeliveryDestination } from '../generated/prisma/enums';
import { NotificationService, type NotifyInput } from '../notifications/notification.service';
import {
  PRD_NOTICE_TYPES,
  WAITING_COMPONENT_OVERDUE_DAYS,
  pluralDays,
  queueNoticeOnce,
} from '../notifications/prd-event-notice';
import { PrismaService } from '../prisma/prisma.service';
import { drainProducerRows, queueNotification } from '../scheduling/day-plan-notification-outbox';
import { REMOVAL_REASONS } from '../scheduling/removal-reason';
import { foldAndResumeSlaPause } from '../ticketing/sla-pause';

/**
 * Component Request — the Warehouse Manager flow (ADR-0008, CONTEXT §Component Request, Issue 22).
 * v1 lifecycle REQUESTED → APPROVED | REJECTED → SHIPPED → RECEIVED. This service owns the WM legs
 * (queue, approve, mark-shipped, reject); the raise lives in the troubleshoot submission (slice 2) and
 * SE Confirm Receipt / resubmit land in later slices. Out-of-order transitions are refused.
 *
 * **#361 — the decisions now reach the engineer.** Every WM leg used to write an audit row and stop,
 * on the reading that the notification channel was an external seam. It was not: the channel landed in
 * #337 and the durable in-transaction enqueue in #338, so the missing piece here was only the
 * producer. An SE whose component request is approved, shipped or refused is the person whose next
 * move depends on the answer — a refusal in particular means they must do something else today — and
 * the only place that knew was `audit_log`. Each transition now enqueues **one** notice to **that
 * request's own SE** inside the same transaction that moves the status (INV-G3).
 */
export interface ComponentRequestView {
  requestId: string;
  ticketId: string;
  seId: string;
  componentId: string | null;
  status: ComponentRequestStatus;
  deliveryDestination: DeliveryDestination | null;
  trackingRef: string | null;
  rejectionReason: string | null;
  createdAt: Date;
}

export interface ComponentRequestRow extends ComponentRequestView {
  componentName: string | null;
  companyName: string;
  zoneName: string;
  ageDays: number;
}

export type WmOutcome =
  | { result: 'OK'; request: ComponentRequestView }
  | { result: 'NOT_FOUND' }
  | { result: 'FORBIDDEN' }
  | { result: 'INVALID_STATE'; status: ComponentRequestStatus };

/**
 * Resubmit ownership (ADR-0008, CONTEXT §8). SOFT_OWN_ORIGINAL re-suggests the original SE first;
 * RETURN_TO_POOL sends the Ticket back to the open Recommendation pool.
 */
export interface ResubmitOwnership {
  mode: 'SOFT_OWN_ORIGINAL' | 'RETURN_TO_POOL';
  seId: string | null;
}

export type ResubmitOutcome =
  | { result: 'OK'; ownership: ResubmitOwnership; request: ComponentRequestView }
  | { result: 'NOT_FOUND' }
  | { result: 'INVALID_STATE'; status: ComponentRequestStatus };

type RequestRow = {
  requestId: string;
  ticketId: string;
  seId: string;
  componentId: bigint | null;
  status: ComponentRequestStatus;
  deliveryDestination: DeliveryDestination | null;
  trackingRef: string | null;
  rejectionReason: string | null;
  createdAt: Date;
};

function toView(row: RequestRow): ComponentRequestView {
  return {
    requestId: row.requestId,
    ticketId: row.ticketId,
    seId: row.seId,
    componentId: row.componentId != null ? String(row.componentId) : null,
    status: row.status,
    deliveryDestination: row.deliveryDestination,
    trackingRef: row.trackingRef,
    rejectionReason: row.rejectionReason,
    createdAt: row.createdAt,
  };
}

const ACTIVE: ComponentRequestStatus[] = ['REQUESTED', 'APPROVED', 'SHIPPED'];

@Injectable()
export class ComponentRequestService {
  private readonly logger = new Logger(ComponentRequestService.name);

  // The default mirrors `RecommenderService`'s own `InventoryService` default: five call sites
  // construct this service by hand (`removal-reason-cancellation`, four component-request specs), and
  // a required second parameter would make every one of them a compile error for no gain. Nest still
  // injects the container's singleton — with the configured channel gateway — wherever DI resolves it.
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService = new NotificationService(prisma),
  ) {}

  /** The Warehouse Manager queue: active requests, newest first, with ticket / SE / component context. */
  async queue(now: Date = new Date()): Promise<ComponentRequestRow[]> {
    return this.buildRows({ status: { in: ACTIVE } }, now);
  }

  /**
   * Manager read-only oversight (Issue 23, CONTEXT §Component Request "Zonal Manager visibility").
   * A ZONAL_MANAGER sees only their own zone's requests (via the ticket's plant→zone); CSM /
   * Operations Head see all zones. Visibility only — the WM owns approval, so no actions are exposed.
   */
  async oversightQueue(scope: { role: string; zoneId: number | null }, now: Date = new Date()): Promise<ComponentRequestRow[]> {
    const restrictZone = scope.role === 'ZONAL_MANAGER' ? scope.zoneId : null;
    const where: Prisma.ComponentRequestWhereInput =
      restrictZone != null ? { ticket: { plant: { zoneId: BigInt(restrictZone) } } } : {};
    return this.buildRows(where, now);
  }

  /**
   * Per-ticket read for the Ticket Detail Components tab (Issue 62). ALL of a ticket's Component
   * Requests, any status, newest-first. Zone-scoped like the oversight list: a ZONAL_MANAGER sees only
   * own-zone tickets (via the ticket's plant→zone); CSM / Operations Head see all zones.
   */
  async byTicket(
    ticketId: string,
    scope: { role: string; zoneId: number | null },
    now: Date = new Date(),
  ): Promise<ComponentRequestRow[]> {
    const restrictZone = scope.role === 'ZONAL_MANAGER' ? scope.zoneId : null;
    const where: Prisma.ComponentRequestWhereInput =
      restrictZone != null
        ? { ticketId, ticket: { plant: { zoneId: BigInt(restrictZone) } } }
        : { ticketId };
    return this.buildRows(where, now);
  }

  /** #163 item 5 — `GET /api/me/component-requests`. The caller's own requests, any status, newest
   *  first — the SE `confirm-receipt`s a request today with no way to read it first. Same row shape
   *  as the manager oversight read; nothing withheld (unlike vehicle-unavailability's SLA-seconds
   *  fields, there is no manager-only data on this row). */
  async bySe(seId: string, now: Date = new Date()): Promise<ComponentRequestRow[]> {
    return this.buildRows({ seId }, now);
  }

  private async buildRows(where: Prisma.ComponentRequestWhereInput, now: Date): Promise<ComponentRequestRow[]> {
    const rows = await this.prisma.componentRequest.findMany({
      where,
      include: { component: true, ticket: { include: { company: true, plant: { include: { zone: true } } } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({
      ...toView(r),
      componentName: r.component?.name ?? null,
      companyName: r.ticket.company.name,
      zoneName: r.ticket.plant.zone.name,
      ageDays: Math.floor((now.getTime() - r.createdAt.getTime()) / (24 * 60 * 60 * 1000)),
    }));
  }

  /** REQUESTED → APPROVED. The SE waiting on the part is told (#361). */
  async approve(requestId: string, actor: { userId: string; role: string }, now: Date = new Date()): Promise<WmOutcome> {
    return this.transition(requestId, 'REQUESTED', actor, now, (tx) =>
      tx.componentRequest.update({
        where: { requestId },
        data: { status: 'APPROVED', approvedAt: now, wmActorId: actor.userId },
      }),
    'COMPONENT_REQUEST_APPROVED',
    (row) => ({
      recipients: [{ userId: row.seId, role: 'SERVICE_ENGINEER' }],
      type: PRD_NOTICE_TYPES.componentRequestApproved,
      title: 'Component request approved',
      body: 'The warehouse approved your component request. You will be told again when it ships.',
      entityType: 'component_request',
      entityId: row.requestId,
      deliveryModel: 'GENERAL',
      metadata: { ticketId: row.ticketId },
    }));
  }

  /** APPROVED → SHIPPED, recording tracking + the delivery destination (drives resubmit ownership). */
  async markShipped(
    requestId: string,
    ship: { trackingRef: string; deliveryDestination: DeliveryDestination },
    actor: { userId: string; role: string },
    now: Date = new Date(),
  ): Promise<WmOutcome> {
    return this.transition(requestId, 'APPROVED', actor, now, (tx) =>
      tx.componentRequest.update({
        where: { requestId },
        data: {
          status: 'SHIPPED',
          shippedAt: now,
          trackingRef: ship.trackingRef,
          deliveryDestination: ship.deliveryDestination,
          wmActorId: actor.userId,
        },
      }),
    'COMPONENT_REQUEST_SHIPPED',
    (row) => ({
      recipients: [{ userId: row.seId, role: 'SERVICE_ENGINEER' }],
      type: PRD_NOTICE_TYPES.componentRequestShipped,
      title: 'Component shipped',
      // The tracking reference and the destination are the whole content of this notice: an engineer
      // who does not know whether the part is coming to them or to the plant warehouse cannot plan
      // tomorrow around it, and the destination is also what decides resubmit ownership below.
      body: `Your component has shipped to ${destinationLabel(ship.deliveryDestination)} — tracking ${ship.trackingRef}.`,
      entityType: 'component_request',
      entityId: row.requestId,
      deliveryModel: 'GENERAL',
      metadata: {
        ticketId: row.ticketId,
        trackingRef: ship.trackingRef,
        deliveryDestination: ship.deliveryDestination,
      },
    }));
  }

  /**
   * SHIPPED → RECEIVED on SE Confirm Receipt. Whether the primary SLA resumes here is governed by the
   * `sla_resume_on_receipt` switch (default OFF, per ADR-0008: resume binds at the ZM-confirmed
   * resubmit). When ON, the paused interval is accumulated and the cycle's pause is cleared now.
   */
  async confirmReceipt(
    requestId: string,
    actor: { userId: string; role: string },
    opts: { now?: Date; resumeOnReceipt?: boolean } = {},
  ): Promise<WmOutcome> {
    const now = opts.now ?? new Date();
    const existing = await this.prisma.componentRequest.findUnique({ where: { requestId } });
    if (!existing) return { result: 'NOT_FOUND' };
    // #162 — any SE could confirm receipt of ANY request, flipping another SE's SHIPPED→RECEIVED and
    // resuming a stranger's SLA clock. Checked ahead of the state branch so a non-owning SE never
    // learns the request's current status.
    if (existing.seId !== actor.userId) return { result: 'FORBIDDEN' };
    if (existing.status !== 'SHIPPED') return { result: 'INVALID_STATE', status: existing.status };
    const resume = await this.resolveResumeOnReceipt(opts.resumeOnReceipt);

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.componentRequest.update({
        where: { requestId },
        data: { status: 'RECEIVED', receivedAt: now },
      });
      if (resume) await this.resumeSla(tx, existing.failureCycleId, now);
      await tx.auditLog.create({
        data: {
          actorId: actor.userId,
          actorRole: actor.role,
          action: 'COMPONENT_REQUEST_RECEIVED',
          entityType: 'component_request',
          entityId: requestId,
          metadata: { ticketId: existing.ticketId, slaResumed: resume, at: now.toISOString() },
        },
      });
      return row;
    });
    return { result: 'OK', request: toView(updated) };
  }

  /**
   * REQUESTED → REJECTED with a mandatory reason.
   *
   * **#361 — the notice goes to the SE, not the ZM.** The old comment here said "the Zonal Manager is
   * notified", which was neither built nor right: the person blocked by a refusal is the engineer who
   * raised it and is still standing at a vehicle they cannot fix. The reason travels with the notice,
   * because "rejected" without it just moves the question rather than answering it. The ZM keeps the
   * oversight queue (`oversightQueue`) and the 7-day escalation below, which are the manager-grain
   * views of the same fact.
   */
  async reject(
    requestId: string,
    reason: string,
    actor: { userId: string; role: string },
    now: Date = new Date(),
  ): Promise<WmOutcome> {
    return this.transition(requestId, 'REQUESTED', actor, now, (tx) =>
      tx.componentRequest.update({
        where: { requestId },
        data: { status: 'REJECTED', rejectedAt: now, rejectionReason: reason, wmActorId: actor.userId },
      }),
    'COMPONENT_REQUEST_REJECTED',
    (row) => ({
      recipients: [{ userId: row.seId, role: 'SERVICE_ENGINEER' }],
      type: PRD_NOTICE_TYPES.componentRequestRejected,
      title: 'Component request rejected',
      body: `The warehouse rejected your component request: ${reason}`,
      entityType: 'component_request',
      entityId: row.requestId,
      deliveryModel: 'GENERAL',
      metadata: { ticketId: row.ticketId, rejectionReason: reason },
    }));
  }

  /**
   * The ZM-confirmed resubmit binding (ADR-0008, CONTEXT §8). On a RECEIVED request: resume the primary
   * SLA (if still paused — the manager-confirmation resume point), reopen the Failure Cycle
   * WAITING_COMPONENT → OPEN so a fresh form can be submitted, and apply resubmit ownership. A Floating
   * SE whose spare went to the Plant warehouse returns the Ticket to the open pool; everyone else keeps
   * soft ownership of the original SE.
   */
  async confirmResubmit(
    requestId: string,
    actor: { userId: string; role: string },
    now: Date = new Date(),
  ): Promise<ResubmitOutcome> {
    const existing = await this.prisma.componentRequest.findUnique({ where: { requestId } });
    if (!existing) return { result: 'NOT_FOUND' };
    if (existing.status !== 'RECEIVED') return { result: 'INVALID_STATE', status: existing.status };

    const engineer = await this.prisma.engineerMaster.findUniqueOrThrow({ where: { engineerId: existing.seId } });
    const ownership = this.computeResubmitOwnership(engineer.coverageType, existing.deliveryDestination, existing.seId);

    const updated = await this.prisma.$transaction(async (tx) => {
      await this.resumeSla(tx, existing.failureCycleId, now);
      await tx.failureCycle.update({ where: { cycleId: existing.failureCycleId }, data: { state: 'OPEN' } });
      if (ownership.mode === 'RETURN_TO_POOL') {
        await tx.ticket.update({
          where: { ticketId: existing.ticketId },
          data: { assignmentState: 'UNASSIGNED', lastStateChangedAt: now },
        });
        // #241 — returning the ticket to the pool has to end its assignment as well. Flipping only
        // `assignment_state` left a live batch row behind, which both keeps the ticket on the old
        // SE's day plan and violates the "FORMALLY_ASSIGNED ⟺ exactly one live row" invariant from
        // the other side. `removed_by` is NULL — the component's arrival did this, not a person.
        await tx.batchAssignmentTicket.updateMany({
          where: { ticketId: existing.ticketId, removedAt: null },
          data: { removedAt: now, removedBy: null, removalReason: REMOVAL_REASONS.COMPONENT_WAIT },
        });
      }
      await tx.auditLog.create({
        data: {
          actorId: actor.userId,
          actorRole: actor.role,
          action: 'COMPONENT_RESUBMIT_BOUND',
          entityType: 'component_request',
          entityId: requestId,
          metadata: {
            ticketId: existing.ticketId,
            ownershipMode: ownership.mode,
            ownershipSeId: ownership.seId,
            at: now.toISOString(),
          },
        },
      });
      return tx.componentRequest.findUniqueOrThrow({ where: { requestId } });
    });
    return { result: 'OK', ownership, request: toView(updated) };
  }

  /** Resubmit ownership rule (ADR-0008, CONTEXT §8). Floating SE is destination-driven; others soft-own. */
  private computeResubmitOwnership(
    coverage: CoverageType,
    destination: DeliveryDestination | null,
    seId: string,
  ): ResubmitOwnership {
    if (coverage === 'FLOATING') {
      return destination === 'SE_LOCATION'
        ? { mode: 'SOFT_OWN_ORIGINAL', seId }
        : { mode: 'RETURN_TO_POOL', seId: null };
    }
    return { mode: 'SOFT_OWN_ORIGINAL', seId };
  }

  /** Read the `sla_resume_on_receipt` switch (default OFF). An explicit override wins (controllers/tests). */
  private async resolveResumeOnReceipt(override?: boolean): Promise<boolean> {
    if (override !== undefined) return override;
    const s = await this.prisma.systemSetting.findUnique({ where: { key: 'sla_resume_on_receipt' } });
    return s?.value === true;
  }

  /**
   * Resume the primary SLA on a paused Failure Cycle: fold the just-ended paused interval into
   * `sla_accumulated_pause_seconds` and clear the pause. No-op if the cycle isn't currently paused.
   * Shared by Confirm-Receipt (switch ON) and the ZM-confirmed resubmit (slice 5).
   */
  private async resumeSla(tx: Prisma.TransactionClient, cycleId: string, now: Date): Promise<void> {
    // #271 — routed through the shared helper. Unconditional (no `onlyReason`): this fires only where
    // this flow's own component-request lifecycle already guarantees the standing pause is the
    // `WAITING_COMPONENT` one it opened — unlike the VU writers, which must not clear a pause they do
    // not own.
    await foldAndResumeSlaPause(tx, cycleId, now);
  }

  /**
   * #361 (INV-G4) — push the ZM the component requests their zone has been waiting on for more than
   * {@link WAITING_COMPONENT_OVERDUE_DAYS}.
   *
   * **The surfacing already existed; only the push was missing.** `dashboard.service.ts` has carried a
   * `waiting_component_overdue` card, zone-scoped and at the same 7-day threshold, since before this
   * slice — which is exactly why the gap was survivable and also why it never got fixed. A card is a
   * thing you see when you happen to open the page; a stalled component request is a ticket whose SLA
   * clock is paused and whose customer is waiting, and the manager who can chase the warehouse has no
   * reason to go and look at a page about it. This sweep is the half that goes and finds them.
   *
   * **One notice per zone per day, not one per request.** Deduplicated on the *zone*, because that is
   * the grain of the action: a ZM with nine stalled requests has one job to do — go and lean on the
   * warehouse — and nine pushes describing it would be the alert storm that gets the channel muted.
   * The count and the oldest age are in the body so the notice is still worth reading on day two.
   */
  async sweepWaitingComponentEscalations(now: Date = new Date()): Promise<{ notified: number }> {
    const cutoff = new Date(now.getTime() - WAITING_COMPONENT_OVERDUE_DAYS * 24 * 60 * 60 * 1000);
    const overdue = await this.prisma.componentRequest.findMany({
      // ACTIVE, not just REQUESTED: a request approved six days ago and never shipped is exactly as
      // stuck as one nobody has looked at, and the SE is waiting either way.
      where: { status: { in: ACTIVE }, createdAt: { lt: cutoff } },
      select: { requestId: true, createdAt: true, ticket: { select: { plant: { select: { zoneId: true } } } } },
      orderBy: { createdAt: 'asc' },
    });
    if (overdue.length === 0) return { notified: 0 };

    const byZone = new Map<string, { zoneId: bigint; requestIds: string[]; oldest: Date }>();
    for (const row of overdue) {
      const zoneId = row.ticket.plant.zoneId;
      const key = zoneId.toString();
      const entry = byZone.get(key) ?? { zoneId, requestIds: [], oldest: row.createdAt };
      entry.requestIds.push(row.requestId);
      if (row.createdAt < entry.oldest) entry.oldest = row.createdAt;
      byZone.set(key, entry);
    }

    const queued = await this.prisma.$transaction(async (tx) => {
      const ids: bigint[] = [];
      for (const { zoneId, requestIds, oldest } of byZone.values()) {
        // #356's policy: the designated manager, else the zone's role holders, else a logged miss —
        // never a silent return on a null `zones.zonal_manager_user_id`.
        const recipients = await this.notifications.zoneManagerRecipients(zoneId, tx);
        if (recipients.length === 0) continue;
        const ageDays = Math.floor((now.getTime() - oldest.getTime()) / (24 * 60 * 60 * 1000));
        const id = await queueNoticeOnce(
          tx,
          {
            recipients,
            type: PRD_NOTICE_TYPES.componentRequestOverdue,
            title: 'Component requests overdue in your zone',
            body:
              `${requestIds.length} component request${requestIds.length === 1 ? ' has' : 's have'} been waiting ` +
              `more than ${pluralDays(WAITING_COMPONENT_OVERDUE_DAYS)} in your zone — the oldest for ` +
              `${pluralDays(ageDays)}. Their tickets' SLA clocks are paused until the parts arrive.`,
            // The zone is the entity, because the zone is what the dedup and the action are keyed on.
            entityType: 'zone',
            entityId: String(zoneId),
            deliveryModel: 'GENERAL',
            metadata: { requestIds, oldestAgeDays: ageDays, thresholdDays: WAITING_COMPONENT_OVERDUE_DAYS },
          },
          now,
        );
        if (id !== null) ids.push(id);
      }
      return ids;
    });

    // Post-commit, off the committed rows (#338): a push that cannot be delivered must not damage — or
    // be lost by — the sweep that found the backlog.
    await drainProducerRows(this.prisma, { notify: this.notifications }, queued, now);
    if (queued.length > 0) this.logger.log(`waiting-component escalation: notified ${queued.length} zone(s)`);
    return { notified: queued.length };
  }

  /**
   * The shared WM transition: guard the from-state, mutate, audit — and, since #361, enqueue the SE's
   * notice **inside the same transaction**.
   *
   * In-transaction is the whole point and not a stylistic preference. The alternative — notify after
   * the commit — is what every one of these legs effectively did by writing only an audit row, and
   * #338 catalogued both ways it fails: a crash between the commit and the push loses the notice with
   * no trace, and a *throw* in the push damages a status change that had already succeeded. The
   * request has moved either way; the notice is a durable row that rides with it, and delivery is
   * attempted afterwards where a failure can only cost a retry.
   *
   * `notice` is a builder over the updated row rather than a prepared value because two of the three
   * legs word themselves from data the mutation itself writes.
   */
  private async transition(
    requestId: string,
    from: ComponentRequestStatus,
    actor: { userId: string; role: string },
    now: Date,
    mutate: (tx: PrismaService) => Promise<RequestRow>,
    action: string,
    notice?: (row: RequestRow) => NotifyInput,
  ): Promise<WmOutcome> {
    const existing = await this.prisma.componentRequest.findUnique({ where: { requestId } });
    if (!existing) return { result: 'NOT_FOUND' };
    if (existing.status !== from) return { result: 'INVALID_STATE', status: existing.status };

    const { updated, queued } = await this.prisma.$transaction(async (tx) => {
      const row = await mutate(tx as unknown as PrismaService);
      await tx.auditLog.create({
        data: {
          actorId: actor.userId,
          actorRole: actor.role,
          action,
          entityType: 'component_request',
          entityId: requestId,
          metadata: { ticketId: existing.ticketId, at: now.toISOString() },
        },
      });
      const outboxId = notice ? await queueNotification(tx, notice(row)) : null;
      return { updated: row, queued: outboxId === null ? [] : [outboxId] };
    });

    await drainProducerRows(this.prisma, { notify: this.notifications }, queued, now);
    return { result: 'OK', request: toView(updated) };
  }
}

/** The destination, in the words the SE mobile Component card already uses. */
function destinationLabel(destination: DeliveryDestination): string {
  return destination === 'SE_LOCATION' ? 'your location' : 'the plant warehouse';
}
