import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { liveScheduleFilter } from './schedule-status';

export interface DayPlanStopTicket {
  ticketId: string;
  sortOrder: number;
}

export interface DayPlanStop {
  batchId: string;
  stopSequence: number;
  plantId: string;
  plantName: string;
  deviceCount: number;
  tickets: DayPlanStopTicket[];
}

export interface DayPlanView {
  dispatched: boolean;
  scheduleId: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  stops: DayPlanStop[];
}

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

  async getDayPlan(seId: string): Promise<DayPlanView> {
    const schedule = await this.prisma.workSchedule.findFirst({
      // #153 — a ZM override flips the schedule to OVERRIDDEN but the SE still has to work it; filtering
      // to ACTIVE alone blanked the entire day plan the moment a ZM touched anything.
      where: { seId, ...liveScheduleFilter() },
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
