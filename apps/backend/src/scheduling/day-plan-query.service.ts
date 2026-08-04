import { Injectable } from '@nestjs/common';
import type { DayPlanStop, DayPlanStopTicket, DayPlanView } from '@fsm/shared';
import { istDate } from '../common/ist-day';
import { PrismaService } from '../prisma/prisma.service';
import { liveScheduleFilter } from './schedule-status';

export type { DayPlanStop, DayPlanStopTicket, DayPlanView } from '@fsm/shared';

const EMPTY: DayPlanView = { dispatched: false, scheduleId: null, dateFrom: null, dateTo: null, stops: [] };

/**
 * The SE Day Plan read model (Issue 11 AC#5). Resolves an SE's current dispatched Work Schedule into
 * ordered, plant-clustered stops — stop sequence, plant name, device count per stop, and the stop's
 * tickets in sort order. Pre-dispatch (no live schedule) returns the empty-state so the mobile Home
 * can show "your plan is being prepared." (The Zone Warehouse pickup step in AC#5 needs component data
 * from Issues 21/22 and is added when that lands.)
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
    });
    if (!schedule) return EMPTY;

    const batches = await this.prisma.plantBatchAssignment.findMany({
      where: { scheduleId: schedule.scheduleId, status: { in: ['AUTO_ASSIGNED', 'OVERRIDDEN'] } },
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
    const stops: DayPlanStop[] = batches
      .filter((b) => b.tickets.length > 0)
      .map((b) => ({
        batchId: String(b.batchId),
        stopSequence: b.stopSequence,
        plantId: String(b.plantId),
        plantName: b.plant.name,
        deviceCount: b.tickets.length,
        tickets: b.tickets.map((t) => ({ ticketId: t.ticketId, sortOrder: t.sortOrder })),
      }));

    return {
      dispatched: true,
      scheduleId: String(schedule.scheduleId),
      dateFrom: schedule.dateFrom.toISOString().slice(0, 10),
      dateTo: schedule.dateTo.toISOString().slice(0, 10),
      stops,
    };
  }
}
