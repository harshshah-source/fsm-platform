import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { type ComponentRequestStatus, type CoverageType, type DeliveryDestination } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Component Request — the Warehouse Manager flow (ADR-0008, CONTEXT §Component Request, Issue 22).
 * v1 lifecycle REQUESTED → APPROVED | REJECTED → SHIPPED → RECEIVED. This service owns the WM legs
 * (queue, approve, mark-shipped, reject); the raise lives in the troubleshoot submission (slice 2) and
 * SE Confirm Receipt / resubmit land in later slices. Out-of-order transitions are refused.
 *
 * Notifications (SE push on ship, ZM notify on reject) are recorded as audit events here and delivered
 * by the notification spine (Issue 03, HITL) — the delivery channel is the external seam, not this slice.
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
  constructor(private readonly prisma: PrismaService) {}

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

  /** REQUESTED → APPROVED. */
  async approve(requestId: string, actor: { userId: string; role: string }, now: Date = new Date()): Promise<WmOutcome> {
    return this.transition(requestId, 'REQUESTED', actor, now, (tx) =>
      tx.componentRequest.update({
        where: { requestId },
        data: { status: 'APPROVED', approvedAt: now, wmActorId: actor.userId },
      }),
    'COMPONENT_REQUEST_APPROVED');
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
    'COMPONENT_REQUEST_SHIPPED');
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

  /** REQUESTED → REJECTED with a mandatory reason (the Zonal Manager is notified — Issue 03 seam). */
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
    'COMPONENT_REQUEST_REJECTED');
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
    const cycle = await tx.failureCycle.findUniqueOrThrow({ where: { cycleId } });
    if (!cycle.slaPaused || !cycle.slaPausedAt) return;
    const addSeconds = Math.floor((now.getTime() - cycle.slaPausedAt.getTime()) / 1000);
    await tx.failureCycle.update({
      where: { cycleId },
      data: {
        slaPaused: false,
        slaPauseReason: null,
        slaPausedAt: null,
        slaPauseSource: null,
        slaAccumulatedPauseSeconds: cycle.slaAccumulatedPauseSeconds + BigInt(addSeconds),
      },
    });
  }

  private async transition(
    requestId: string,
    from: ComponentRequestStatus,
    actor: { userId: string; role: string },
    now: Date,
    mutate: (tx: PrismaService) => Promise<RequestRow>,
    action: string,
  ): Promise<WmOutcome> {
    const existing = await this.prisma.componentRequest.findUnique({ where: { requestId } });
    if (!existing) return { result: 'NOT_FOUND' };
    if (existing.status !== from) return { result: 'INVALID_STATE', status: existing.status };

    const updated = await this.prisma.$transaction(async (tx) => {
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
      return row;
    });
    return { result: 'OK', request: toView(updated) };
  }
}
