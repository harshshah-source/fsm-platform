import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ActorContext, AssignOutcome, OverrideOutcome, OverrideService } from './override.service';
import { ZmScope } from './zm-schedule-query.service';

/**
 * ZM manual same-day update (Issue 31). The ZM adds / removes / reorders Tickets on an SE's current
 * Day Plan mid-shift — distinct from the system-triggered CRITICAL insertion (Issue 29). Each change
 * applies immediately (no SE Acceptance) and is logged as a `MANUAL_ZM_UPDATE` row so it surfaces in
 * the **Intra-day Queue**. Per the 2026-06-25 decision the queue is a **view over AuditLog** (no new
 * model); Issue 29 later writes its CRITICAL-insertion rows into the same view.
 *
 * The mutations reuse the Issue 13 override engine; this service only re-tags the audit action and
 * exposes the zone-scoped read.
 */
export type IntradayUpdateType = 'ADD' | 'REMOVE' | 'REORDER';

export interface IntradayUpdateRow {
  auditId: string;
  actorId: string;
  actorRole: string;
  updateType: IntradayUpdateType;
  ticketId: string | null;
  seId: string | null;
  createdAt: string;
}

const MANUAL_ZM_UPDATE = 'MANUAL_ZM_UPDATE';

@Injectable()
export class SameDayUpdateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly override: OverrideService,
  ) {}

  /** Add an open Ticket to the SE's current Day Plan, logged as a MANUAL_ZM_UPDATE/ADD intra-day row. */
  addTicket(
    ticketId: string,
    seId: string,
    scope: ZmScope,
    actor: ActorContext,
    now: Date = new Date(),
  ): Promise<AssignOutcome> {
    return this.override.assignTicket(ticketId, seId, scope, actor, now, MANUAL_ZM_UPDATE);
  }

  /** Remove a Ticket from the SE's current Day Plan (returns it to the Shared Pool), logged as a
   *  MANUAL_ZM_UPDATE/REMOVE intra-day row. ON_SITE conflict gating + mandatory reason are the engine's
   *  (resend with `confirm: true` after the CONFLICT_ON_SITE warning). */
  removeTicket(
    batchId: bigint,
    ticketId: string,
    reasonCode: string,
    confirm: boolean,
    scope: ZmScope,
    actor: ActorContext,
    now: Date = new Date(),
  ): Promise<OverrideOutcome> {
    return this.override.override(
      batchId,
      { action: 'REMOVE_TICKET', ticketId, reasonCode, confirm },
      scope,
      actor,
      now,
      MANUAL_ZM_UPDATE,
    );
  }

  /** Reorder a stop within the SE's current Day Plan, logged as a MANUAL_ZM_UPDATE/REORDER intra-day row. */
  reorder(
    batchId: bigint,
    stopSequence: number,
    reasonCode: string,
    scope: ZmScope,
    actor: ActorContext,
    now: Date = new Date(),
  ): Promise<OverrideOutcome> {
    return this.override.override(
      batchId,
      { action: 'REORDER', stopSequence, reasonCode },
      scope,
      actor,
      now,
      MANUAL_ZM_UPDATE,
    );
  }

  /**
   * The Intra-day Queue read — MANUAL_ZM_UPDATE audit rows newest-first, zone-scoped: a ZONAL_MANAGER
   * sees only updates in their own zone; cross-zone roles (CSM / Operations Head) see all. ADD rows are
   * ticket-entity (zone via the ticket's plant); REMOVE / REORDER rows are batch-entity (zone via the
   * batch's schedule), carrying the ticket id (REMOVE) or none (REORDER) in metadata.
   */
  async listIntradayUpdates(scope: ZmScope): Promise<IntradayUpdateRow[]> {
    const logs = await this.prisma.auditLog.findMany({
      where: { action: MANUAL_ZM_UPDATE },
      orderBy: { createdAt: 'desc' },
    });
    const zmZone = scope.role === 'ZONAL_MANAGER' && scope.zoneId != null ? BigInt(scope.zoneId) : null;

    const ticketZone = await this.zonesForTickets(logs.filter((l) => l.entityType === 'ticket').map((l) => l.entityId));
    const batchZone = await this.zonesForBatches(logs.filter((l) => l.entityType === 'plant_batch_assignment').map((l) => l.entityId));

    const rows: IntradayUpdateRow[] = [];
    for (const l of logs) {
      const meta = (l.metadata ?? {}) as Record<string, unknown>;
      const zone = l.entityType === 'ticket' ? ticketZone.get(l.entityId) : batchZone.get(l.entityId);
      if (zmZone != null && zone !== zmZone) continue;
      const ticketId =
        l.entityType === 'ticket' ? l.entityId : typeof meta.ticketId === 'string' ? meta.ticketId : null;
      rows.push({
        auditId: String(l.id),
        actorId: l.actorId,
        actorRole: l.actorRole,
        updateType: (meta.updateType as IntradayUpdateType) ?? 'ADD',
        ticketId,
        seId: typeof meta.seId === 'string' ? meta.seId : null,
        createdAt: l.createdAt.toISOString(),
      });
    }
    return rows;
  }

  private async zonesForTickets(ticketIds: string[]): Promise<Map<string, bigint>> {
    if (ticketIds.length === 0) return new Map();
    const tickets = await this.prisma.ticket.findMany({
      where: { ticketId: { in: [...new Set(ticketIds)] } },
      select: { ticketId: true, plant: { select: { zoneId: true } } },
    });
    return new Map(tickets.map((t) => [t.ticketId, t.plant.zoneId]));
  }

  private async zonesForBatches(batchIds: string[]): Promise<Map<string, bigint>> {
    if (batchIds.length === 0) return new Map();
    const batches = await this.prisma.plantBatchAssignment.findMany({
      where: { batchId: { in: [...new Set(batchIds)].map((id) => BigInt(id)) } },
      select: { batchId: true, schedule: { select: { zoneId: true } } },
    });
    return new Map(batches.map((b) => [String(b.batchId), b.schedule.zoneId]));
  }
}
