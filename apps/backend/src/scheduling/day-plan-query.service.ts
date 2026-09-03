import { Injectable } from '@nestjs/common';
import type { DayPlanStop, DayPlanStopTicket, DayPlanView } from '@fsm/shared';
import { istDate } from '../common/ist-day';
import { PrismaService } from '../prisma/prisma.service';
import { liveBatchFilter, liveScheduleFilter } from './schedule-status';
import { warehousePickupStop } from './warehouse-pickup';

export type { DayPlanStop, DayPlanStopTicket, DayPlanView } from '@fsm/shared';

const EMPTY: DayPlanView = { dispatched: false, scheduleId: null, dateFrom: null, dateTo: null, stops: [] };

/**
 * The SE Day Plan read model (Issue 11 AC#5). Resolves an SE's current dispatched Work Schedule into
 * ordered, plant-clustered stops — stop sequence, plant name, device count per stop, and the stop's
 * tickets in sort order. Pre-dispatch (no live schedule) returns the empty-state so the mobile Home
 * can show "your plan is being prepared."
 *
 * **#366 — the Zone Warehouse pickup step (AC#5) now lands here**, as stop 0 ahead of the plant
 * stops, when a ticket on this plan has a component request that is SHIPPED and not yet RECEIVED.
 * It is a stop rather than a note above the list because the day is one ordered sequence and the
 * engineer cannot work stop 1 without the part; `warehouse-pickup.ts` owns the rule and explains why
 * it is derived at read time instead of stamped on the schedule. A plan with nothing waiting is the
 * plan this read has always returned, one field wider: every stop now names its `kind`.
 */
@Injectable()
export class DayPlanQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * `opts.now` decides which day "today" is — injected only so fixtures can state their own clock;
   * production always passes nothing and gets the wall clock.
   */
  async getDayPlan(seId: string, opts: { now?: Date } = {}): Promise<DayPlanView> {
    const today = istDate(opts.now ?? new Date());
    const schedule = await this.prisma.workSchedule.findFirst({
      // #153 — a ZM override flips the schedule to OVERRIDDEN but the SE still has to work it; filtering
      // to ACTIVE alone blanked the entire day plan the moment a ZM touched anything.
      //
      // #147 — the date predicate, not the ordering, decides which plan is today's. Without it an SE
      // with no dispatch today was served yesterday's stops as today's, and #127's APPEND made the
      // `dispatchedAt` tiebreak actively wrong: appending to a schedule does not refresh the stamp, so
      // it no longer tracks last-modification and an older day could sort first. Ordering now only
      // breaks ties among schedules that all genuinely cover today.
      where: { seId, dateFrom: { lte: today }, dateTo: { gte: today }, ...liveScheduleFilter() },
      orderBy: { dispatchedAt: 'desc' },
      // #366 — the zone names the warehouse the SE collects from; there is no warehouse row to read.
      include: { zone: { select: { name: true } } },
    });
    if (!schedule) return EMPTY;

    const batches = await this.prisma.plantBatchAssignment.findMany({
      // #321 — shared with the dispatch notification's counts, which are asserted against this read.
      where: { scheduleId: schedule.scheduleId, ...liveBatchFilter() },
      orderBy: { stopSequence: 'asc' },
      include: {
        plant: { select: { name: true } },
        tickets: {
          where: { removedAt: null },
          orderBy: { sortOrder: 'asc' },
          select: { ticketId: true, sortOrder: true },
        },
      },
    });

    // #179 slice 3 — a batch every one of whose tickets has been removed (a bulk unassign or an
    // override) is a hollow stop: it would render above the SE's real remaining work with
    // deviceCount 0. It carries no live work, so it is never shown, not just shown empty.
    const liveBatches = batches.filter((b) => b.tickets.length > 0);
    const stops: DayPlanStop[] = liveBatches.map((b) => ({
      kind: 'PLANT',
      batchId: String(b.batchId),
      stopSequence: b.stopSequence,
      plantId: String(b.plantId),
      plantName: b.plant.name,
      deviceCount: b.tickets.length,
      tickets: b.tickets.map((t) => ({ ticketId: t.ticketId, sortOrder: t.sortOrder })),
    }));

    // #366 — derived from the plan's LIVE tickets, so a part for a ticket a bulk unassign took off
    // the plan this morning does not send the engineer to the warehouse for it.
    const pickup = await warehousePickupStop(this.prisma, {
      ticketIds: liveBatches.flatMap((b) => b.tickets.map((t) => t.ticketId)),
      zoneName: schedule.zone.name,
    });

    return {
      dispatched: true,
      scheduleId: String(schedule.scheduleId),
      dateFrom: schedule.dateFrom.toISOString().slice(0, 10),
      dateTo: schedule.dateTo.toISOString().slice(0, 10),
      // Stop 0 first, and only when it exists: with nothing waiting this is the array it always was.
      stops: pickup === null ? stops : [pickup, ...stops],
    };
  }
}
