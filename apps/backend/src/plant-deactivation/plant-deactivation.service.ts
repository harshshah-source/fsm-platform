import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import type { $Enums } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LIVE_FAILURE_CYCLE_STATES, RESOLVED_TICKET_STATUSES } from '../ticketing/resolved-ticket-status';
import { REMOVAL_REASONS } from '../scheduling/removal-reason';
import { liveBatchFilter, liveScheduleFilter } from '../scheduling/schedule-status';
import {
  DAY_PLAN_ACTION_PLANT_DEACTIVATED,
  queueDayPlanOverridden,
} from '../scheduling/day-plan-notification-outbox';
import { istDate } from '../common/ist-day';
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

/**
 * Terminal ticket statuses — everything else is "open" work a deactivation cancels.
 *
 * #308 — the second **divergent** copy (four members). Now the canonical seven, so a ticket already
 * terminal at `FAILED_VERIFICATION` / `FAILED_ACTIVATION` / `RECEIVED_AT_WAREHOUSE` keeps its own
 * closure instead of being re-closed as `CLOSED / OPERATIONS_HEAD_OVERRIDE_CLOSE` with a second
 * closure event on top. Its still-live failure cycle is ended directly — see `cancelOpenTickets`.
 */
const TERMINAL_TICKET_STATUSES: $Enums.TicketStatus[] = [...RESOLVED_TICKET_STATUSES];

export type DeactivateResult =
  | { result: 'OK'; deactivationId: string; cancelledTickets: number }
  | { result: 'PLANT_NOT_FOUND' }
  | { result: 'ALREADY_DEACTIVATED' };

export type ReactivateResult =
  | { result: 'OK'; cancelledTicketsAtDeactivation: number | null }
  | { result: 'NOT_DEACTIVATED' };

/** One SE's stop that a deactivation took off a live Day Plan — the addressee of a #345 notice. */
interface StrippedStop {
  batchId: bigint;
  scheduleId: bigint;
  seId: string;
}

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
    const plant = await this.prisma.plant.findUnique({ where: { plantId }, select: { plantId: true, name: true } });
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
          const { cancelledTickets, strippedStops } = await this.cancelOpenTickets(tx, plantId, reason, actor, now);
          // #345 (spine edge E-26) — the SEs whose plan just lost a stop are told, INSIDE this
          // transaction. #241 already ended their assignments here; the news that they had was
          // carried by "a human remembers". The notice therefore commits with the cancellation or
          // not at all — a post-commit call would leave the plan silently short whenever the process
          // died between the two, and a throw in it would undo an Operations-Head decision that had
          // already happened (#338).
          //
          // No post-commit drain here, deliberately: this module owns no `DayPlanNotifier` and
          // acquiring one would mean importing `SchedulingModule` into `PlantDeactivationModule` for
          // a single port. The `business-notification-outbox` sweep already carries it and runs every
          // two minutes (`DEFAULT_NOTIFICATION_OUTBOX_CRON`), which is the right latency for news an
          // engineer reacts to by *not* driving somewhere. Wiring the port for an immediate drain is a
          // strict improvement, not a correctness one — see this slice's report.
          for (const stop of strippedStops) {
            await queueDayPlanOverridden(tx, {
              seId: stop.seId,
              scheduleId: stop.scheduleId,
              batchId: stop.batchId,
              action: DAY_PLAN_ACTION_PLANT_DEACTIVATED,
              plantName: plant.name,
            });
          }
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
  ): Promise<{ cancelledTickets: number; strippedStops: StrippedStop[] }> {
    // Every ticket on the plant, so the live-cycle sweep below can also see cycles hanging off
    // ALREADY-terminal tickets (#308) — `open` is only the subset this deactivation closes.
    const allTickets = await tx.ticket.findMany({
      where: { plantId },
      select: { ticketId: true, status: true, failureCycleId: true },
    });
    const terminal = new Set<string>(TERMINAL_TICKET_STATUSES);
    const open = allTickets.filter((t) => !terminal.has(t.status));
    const closed: typeof open = [];
    for (const ticket of open) {
      // #308 — the status guard is in the WHERE. This loop makes one round trip per ticket, so the
      // read above can be many tickets stale by the time a late one is written; a ticket that reached
      // a terminal state meanwhile keeps its own closure rather than having it overwritten here.
      const { count } = await tx.ticket.updateMany({
        where: { ticketId: ticket.ticketId, status: { notIn: TERMINAL_TICKET_STATUSES } },
        data: {
          status: 'CLOSED',
          closureType: 'OPERATIONS_HEAD_OVERRIDE_CLOSE',
          closureReason: `PLANT_DEACTIVATED: ${reason}`,
          closedAt: now,
          lastStateChangedAt: now,
        },
      });
      if (count === 0) continue;
      closed.push(ticket);
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
    }
    // Terminate the parent Failure Cycles (state → FAILED so they leave the one-active-per-device set,
    // letting reactivation's next pipeline run open a fresh cycle; FAILED, not VERIFIED, so the
    // re-created ticket is not mis-flagged a REPEAT).
    //
    // #308 — taken from the plant's cycles rather than only the tickets just closed, and guarded on the
    // cycle still being live. A `FAILED_VERIFICATION` ticket is terminal while its cycle is not, so the
    // old ticket-driven write reached that cycle only as a side effect of re-closing a ticket that was
    // already over; the flag-clear below covers the whole plant either way.
    const cycleIds = allTickets.map((t) => t.failureCycleId).filter((c): c is string => c !== null);
    if (cycleIds.length > 0) {
      await tx.failureCycle.updateMany({
        where: { cycleId: { in: cycleIds }, state: { in: [...LIVE_FAILURE_CYCLE_STATES] } },
        data: { state: 'FAILED', closedAt: now },
      });
    }
    // #241 — end the assignments too, in the same transaction. Day-plan reads filter on
    // `removed_at IS NULL` and not on ticket status, so a cancelled ticket whose batch row stayed
    // live kept appearing as work to do on an SE's plan. Symmetric with the device-departure path.
    // `removed_by` is NULL: the OH deactivated the *plant*, nobody withdrew these tickets by hand.
    const strippedStops: StrippedStop[] = [];
    if (closed.length > 0) {
      // #345 — read the affected stops BEFORE the strip below, because the strip is what destroys the
      // evidence: after it every one of these rows has `removed_at` set and the same query answers
      // nothing. Narrowed to a **live** stop on a **live** plan (`schedule-status.ts`, the one
      // definition of both, and the IST day the plan covers): a row still hanging off a plan from
      // last week is #242's un-recycled history, and waking an engineer for a stop that stopped being
      // theirs days ago is noise, not news.
      const today = istDate(now);
      const affected = await tx.batchAssignmentTicket.findMany({
        where: {
          ticketId: { in: closed.map((t) => t.ticketId) },
          removedAt: null,
          batch: {
            ...liveBatchFilter(),
            schedule: { ...liveScheduleFilter(), dateFrom: { lte: today }, dateTo: { gte: today } },
          },
        },
        select: { batch: { select: { batchId: true, scheduleId: true, seId: true } } },
      });
      // One notice per stop, not per ticket: a plant is one stop on the plan, and an SE whose batch
      // held four of this plant's tickets lost that stop once.
      const byBatch = new Map<bigint, StrippedStop>();
      for (const row of affected) byBatch.set(row.batch.batchId, row.batch);
      strippedStops.push(...byBatch.values());

      await tx.batchAssignmentTicket.updateMany({
        where: { ticketId: { in: closed.map((t) => t.ticketId) }, removedAt: null },
        data: { removedAt: now, removedBy: null, removalReason: REMOVAL_REASONS.TICKET_CANCELLED },
      });
    }
    // Clear the hot-state open-cycle flag for the plant's devices — the ticket-creation gate keys on it.
    await tx.deviceState.updateMany({ where: { plantId }, data: { hasOpenFailureCycle: false } });
    return { cancelledTickets: closed.length, strippedStops };
  }
}
