import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import type { $Enums } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService, auditActor } from '../audit/audit.service';
import type { RequestActor } from '../common/request-actor';

/**
 * FSM-owned plant deactivation (Issue 119). Deactivation is an OH-owned, fully-reversible overlay in
 * the `plant_deactivations` side table (never touched by master-sync). Deactivating a plant, in one
 * transaction: records the deactivation, CANCELS its open tickets (status → CLOSED, reasonCode
 * PLANT_DEACTIVATED, parent Failure Cycle terminated) and writes one PLANT_DEACTIVATED audit row.
 * Reactivation stamps the history row; the next pipeline run re-creates tickets for still-inactive
 * devices (no ticket is resurrected). Downstream exclusions (eligibility/ticket-creation, dashboard
 * counts, dispatch) read {@link activeDeactivatedPlantIds}.
 */

/** Terminal ticket statuses — everything else is "open" work a deactivation cancels. */
const TERMINAL_TICKET_STATUSES: $Enums.TicketStatus[] = [
  'CLOSED',
  'CLOSED_AUTO_RECOVERY',
  'CLOSED_NON_OPERATIONAL',
  'FAILED_RECOVERY',
];

export type DeactivateResult =
  | { result: 'OK'; deactivationId: string; cancelledTickets: number }
  | { result: 'PLANT_NOT_FOUND' }
  | { result: 'ALREADY_DEACTIVATED' };

export type ReactivateResult =
  | { result: 'OK'; cancelledTicketsAtDeactivation: number | null }
  | { result: 'NOT_DEACTIVATED' };

export interface DeactivationRow {
  id: string;
  plantId: string;
  plantName: string;
  sourcePlantId: string | null;
  company: string | null;
  zone: string | null;
  deviceCount: number;
  reason: string;
  deactivatedBy: string | null;
  deactivatedAt: string;
}

@Injectable()
export class PlantDeactivationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async deactivate(plantId: bigint, reason: string, actor: RequestActor): Promise<DeactivateResult> {
    const plant = await this.prisma.plant.findUnique({ where: { plantId }, select: { plantId: true } });
    if (!plant) return { result: 'PLANT_NOT_FOUND' };

    const existing = await this.prisma.plantDeactivation.findFirst({
      where: { plantId, reactivatedAt: null },
      select: { id: true },
    });
    if (existing) return { result: 'ALREADY_DEACTIVATED' };

    const now = new Date();
    try {
      return await this.audit.withAudit(
        {
          ...auditActor(actor),
          action: 'PLANT_DEACTIVATED',
          entityType: 'PLANT',
          entityId: String(plantId),
          metadata: { reason },
        },
        async (tx): Promise<DeactivateResult> => {
          const cancelledTickets = await this.cancelOpenTickets(tx, plantId, reason, actor, now);
          const created = await tx.plantDeactivation.create({
            data: { plantId, reason, deactivatedBy: actor.userId, deactivatedAt: now },
            select: { id: true },
          });
          return { result: 'OK', deactivationId: String(created.id), cancelledTickets };
        },
      );
    } catch (e) {
      // The partial-unique index is the race backstop if two deactivations run concurrently.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return { result: 'ALREADY_DEACTIVATED' };
      }
      throw e;
    }
  }

  async reactivate(plantId: bigint, reason: string | null, actor: RequestActor): Promise<ReactivateResult> {
    const active = await this.prisma.plantDeactivation.findFirst({
      where: { plantId, reactivatedAt: null },
      select: { id: true },
    });
    if (!active) return { result: 'NOT_DEACTIVATED' };

    return this.audit.withAudit(
      {
        ...auditActor(actor),
        action: 'PLANT_REACTIVATED',
        entityType: 'PLANT',
        entityId: String(plantId),
        metadata: reason ? { reason } : {},
      },
      async (tx): Promise<ReactivateResult> => {
        await tx.plantDeactivation.update({
          where: { id: active.id },
          data: { reactivatedAt: new Date(), reactivatedBy: actor.userId, reactivationReason: reason },
        });
        return { result: 'OK', cancelledTicketsAtDeactivation: null };
      },
    );
  }

  /** Active deactivations enriched for the OH admin list (plant/company/zone/device-count/actor/date). */
  async list(): Promise<DeactivationRow[]> {
    const rows = await this.prisma.$queryRaw<
      {
        id: bigint;
        plantId: bigint;
        plantName: string;
        sourcePlantId: bigint | null;
        company: string | null;
        zone: string | null;
        deviceCount: number;
        reason: string;
        deactivatedBy: string | null;
        deactivatedAt: Date;
      }[]
    >(Prisma.sql`
      SELECT pd.id AS "id", pd.plant_id AS "plantId", p.name AS "plantName",
             p.source_plant_id AS "sourcePlantId", z.name AS "zone",
             (SELECT c.name FROM device_states ds JOIN company_master c ON c.company_id = ds.company_id
                WHERE ds.plant_id = pd.plant_id GROUP BY c.name ORDER BY COUNT(*) DESC LIMIT 1) AS "company",
             (SELECT COUNT(*)::int FROM device_states ds WHERE ds.plant_id = pd.plant_id) AS "deviceCount",
             pd.reason AS "reason", pd.deactivated_by::text AS "deactivatedBy", pd.deactivated_at AS "deactivatedAt"
      FROM plant_deactivations pd
      JOIN plants p ON p.plant_id = pd.plant_id
      LEFT JOIN zones z ON z.zone_id = p.zone_id
      WHERE pd.reactivated_at IS NULL
      ORDER BY pd.deactivated_at DESC`);

    return rows.map((r) => ({
      id: String(r.id),
      plantId: String(r.plantId),
      plantName: r.plantName,
      sourcePlantId: r.sourcePlantId === null ? null : String(r.sourcePlantId),
      company: r.company,
      zone: r.zone,
      deviceCount: r.deviceCount,
      reason: r.reason,
      deactivatedBy: r.deactivatedBy,
      deactivatedAt: r.deactivatedAt.toISOString(),
    }));
  }

  /** Cancel every open ticket on the plant: status → CLOSED (reason PLANT_DEACTIVATED), cycle terminated. */
  private async cancelOpenTickets(
    tx: Prisma.TransactionClient,
    plantId: bigint,
    reason: string,
    actor: RequestActor,
    now: Date,
  ): Promise<number> {
    const open = await tx.ticket.findMany({
      where: { plantId, status: { notIn: TERMINAL_TICKET_STATUSES } },
      select: { ticketId: true, status: true, failureCycleId: true },
    });
    for (const ticket of open) {
      await tx.ticket.update({
        where: { ticketId: ticket.ticketId },
        data: {
          status: 'CLOSED',
          closureType: 'OPERATIONS_HEAD_OVERRIDE_CLOSE',
          closureReason: `PLANT_DEACTIVATED: ${reason}`,
          closedAt: now,
          lastStateChangedAt: now,
        },
      });
      await tx.ticketEvent.create({
        data: {
          ticketId: ticket.ticketId,
          fromState: ticket.status,
          toState: 'CLOSED',
          actorId: actor.userId,
          actorRole: actor.role as $Enums.Role,
          reasonCode: 'PLANT_DEACTIVATED',
          at: now,
        },
      });
      // Terminate the parent Failure Cycle (state → FAILED so it leaves the one-active-per-device set,
      // letting reactivation's next pipeline run open a fresh cycle; FAILED, not VERIFIED, so the
      // re-created ticket is not mis-flagged a REPEAT).
      if (ticket.failureCycleId) {
        await tx.failureCycle.update({
          where: { cycleId: ticket.failureCycleId },
          data: { state: 'FAILED', closedAt: now },
        });
      }
    }
    // Clear the hot-state open-cycle flag for the plant's devices — the ticket-creation gate keys on it.
    await tx.deviceState.updateMany({ where: { plantId }, data: { hasOpenFailureCycle: false } });
    return open.length;
  }
}
