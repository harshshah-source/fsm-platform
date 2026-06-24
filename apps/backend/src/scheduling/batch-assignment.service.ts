import { Inject, Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  DAY_PLAN_NOTIFIER,
  type DayPlanNotifier,
  LoggingDayPlanNotifier,
} from './day-plan-notifier';

export interface DispatchOptions {
  /** Day Plan coverage start (Schedule Cadence: daily → dateFrom === dateTo). */
  dateFrom: Date;
  dateTo: Date;
  now?: Date;
}

export interface DispatchSummary {
  schedules: number;
  batches: number;
  tickets: number;
}

/**
 * The BatchAssignmentWorker (LLD §13.1 step 6, Issue 11). Turns the Recommender's SUGGESTED
 * recommendations for a zone into a dispatched Day Plan: one ACTIVE WorkSchedule per SE, the SE's
 * tickets grouped into one AUTO_ASSIGNED Plant-wise Batch Assignment per plant, and the batch's
 * tickets. Dispatched directly — no approval gate (Decision §7, ADR-0007/0019 superseded); the ZM
 * overrides post-hoc. Invokable method (no cron yet — same posture as RecommenderService.runForZone).
 */
@Injectable()
export class BatchAssignmentService {
  private readonly notifier: DayPlanNotifier;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(DAY_PLAN_NOTIFIER) notifier?: DayPlanNotifier,
  ) {
    this.notifier = notifier ?? new LoggingDayPlanNotifier();
  }

  async dispatchForZone(zoneId: bigint, opts: DispatchOptions): Promise<DispatchSummary> {
    const now = opts.now ?? new Date();

    // SUGGESTED recommendations in this zone with a chosen SE, in canonical processing order.
    const recs = await this.prisma.recommendation.findMany({
      where: { status: 'SUGGESTED', seId: { not: null }, ticket: { plant: { zoneId } } },
      select: { ticketId: true, seId: true, ticket: { select: { plantId: true } } },
      orderBy: { processingRank: 'asc' },
    });

    // se_id → plant_id → ticket_ids (insertion order = canonical order).
    const bySe = new Map<string, Map<bigint, string[]>>();
    for (const r of recs) {
      const seId = r.seId!;
      const plantId = r.ticket.plantId;
      const byPlant = bySe.get(seId) ?? new Map<bigint, string[]>();
      const tickets = byPlant.get(plantId) ?? [];
      tickets.push(r.ticketId);
      byPlant.set(plantId, tickets);
      bySe.set(seId, byPlant);
    }

    let schedules = 0;
    let batches = 0;
    let tickets = 0;

    for (const [seId, byPlant] of bySe) {
      const schedule = await this.prisma.workSchedule.create({
        data: {
          seId,
          zoneId,
          dateFrom: opts.dateFrom,
          dateTo: opts.dateTo,
          status: 'ACTIVE',
          source: 'SYSTEM_GENERATED',
          dispatchedAt: now,
        },
      });
      schedules++;

      let stopSequence = 0;
      let scheduleTickets = 0;
      for (const [plantId, ticketIds] of this.orderPlantStops(byPlant)) {
        stopSequence++;
        const batch = await this.prisma.plantBatchAssignment.create({
          data: { scheduleId: schedule.scheduleId, plantId, seId, status: 'AUTO_ASSIGNED', stopSequence },
        });
        batches++;

        let sortOrder = 0;
        for (const ticketId of ticketIds) {
          sortOrder++;
          await this.prisma.batchAssignmentTicket.create({
            data: { batchId: batch.batchId, ticketId, sortOrder },
          });
          // Committed work leaves the Shared Pool (Issue 12): the dispatched ticket is now a Formal
          // Assignment, not pickable secondary work (schema D6, LLD shared-pool partial index).
          await this.prisma.ticket.update({
            where: { ticketId },
            data: { assignmentState: 'FORMALLY_ASSIGNED' },
          });
          tickets++;
          scheduleTickets++;
        }
      }

      // "Day Plan is live" — fires regardless of channel availability (AC#4); the seam swaps to the
      // Issue 03 notification spine without changing this dispatch contract.
      await this.notifier.dayPlanDispatched({
        seId,
        scheduleId: schedule.scheduleId,
        zoneId,
        stops: stopSequence,
        tickets: scheduleTickets,
      });
    }

    return { schedules, batches, tickets };
  }

  /**
   * Stop-ordering seam (AC#3). Recommendations arrive in canonical processing order, so each plant's
   * insertion position already reflects the rank of its lead (best) ticket — the deterministic key we
   * order stops by today. Distance-from-previous-stop is deferred-neutral (Issue 10); this is the
   * hook that swaps to PostGIS route-distance once day-plan geo exists (Issue 14).
   */
  private orderPlantStops(byPlant: Map<bigint, string[]>): [bigint, string[]][] {
    return [...byPlant.entries()];
  }
}
