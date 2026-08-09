import { Injectable } from '@nestjs/common';
import type { MeWorkHistoryDay, MeWorkHistoryView } from '@fsm/shared';
import { istDate, IST_OFFSET_MS } from '../common/ist-day';
import { PrismaService } from '../prisma/prisma.service';

export type { MeWorkHistoryDay, MeWorkHistoryView } from '@fsm/shared';

/** The closure states that count as work completed. **Deliberately identical to the Home KPI strip's
 *  COMPLETED tile** (`apps/mobile/src/home/homeKpi.ts`, operator-confirmed 2026-08-04): a chart bar and
 *  the tile above it sit on the same screen, so a second definition would be visible as a contradiction.
 *  `CLOSED_NON_OPERATIONAL` is excluded for the same reason it is there — a vehicle written off is not
 *  work the SE completed. */
const COMPLETED_STATES = ['CLOSED', 'CLOSED_AUTO_RECOVERY'];

/** Request bound. 31 days is a month of bars — far past anything the 7-bar chart asks for, and small
 *  enough that the two queries below stay index-sized however the client is called. */
const MAX_DAYS = 31;
const DEFAULT_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` of a UTC-midnight `@db.Date`-shaped value (what {@link istDate} returns). */
const isoDay = (utcMidnight: Date): string => utcMidnight.toISOString().slice(0, 10);

/**
 * #175 — `GET /api/me/work-history?days=N`, the per-day assigned/completed series behind the Home
 * screen's "Assigned vs Completed" chart (`docs/ui/mobile/home-dashboard.png`).
 *
 * **The definition, which #175 required be settled before building rather than guessed:**
 *
 * - **assigned(D)** — the distinct tickets sitting in the SE's plant batches on every `work_schedule`
 *   whose `[dateFrom, dateTo]` covers IST day D, excluding tickets a ZM removed from the plan
 *   (`removedAt`). Same "assigned" the live read (`MeTicketsQueryService`) means, evaluated per day
 *   instead of only for the current schedule.
 * - **completed(D)** — of *that day's assigned set*, the tickets carrying a `ticket_events` row whose
 *   `toState` is a closure state and whose `at` falls inside IST day D.
 *
 * Two consequences worth stating because they are the point, not side-effects:
 *
 * 1. `completed ⊆ assigned` **by construction**. A ticket closed on a day it was not assigned to this
 *    SE (e.g. someone else's, or one of this SE's own that was removed from the plan) never lands in a
 *    bar. That is what lets the chart print `4/6` as a fraction.
 * 2. Completion is read from `ticket_events`, **not** from `tickets.status`. The event ledger records
 *    *when* a transition happened and is append-only; the status column records only where a ticket
 *    ended up, so it cannot answer "what did this SE complete on 09 May" at all once a ticket moves
 *    again. It is also the same ledger a ZM's view of the day reads, which is #175's AC that the two
 *    must agree.
 *
 * Days on which the SE had no schedule return `{ assigned: 0, completed: 0 }` rather than dropping out,
 * so the client renders N bars regardless and never has to reconstruct the calendar.
 */
@Injectable()
export class MeWorkHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  async getWorkHistory(
    seId: string,
    options: { days?: number; now?: Date } = {},
  ): Promise<MeWorkHistoryView> {
    const now = options.now ?? new Date();
    const days = clampDays(options.days);

    // The N IST calendar days ending today, oldest first. `istDate` returns UTC midnight of the IST
    // date, which is exactly the form `@db.Date` columns marshal to — so these values compare directly
    // against `dateFrom`/`dateTo` with no further conversion.
    const today = istDate(now);
    const dates = Array.from({ length: days }, (_, i) => new Date(today.getTime() - (days - 1 - i) * DAY_MS));
    const firstDate = dates[0];
    const lastDate = dates[dates.length - 1];

    const assignedByDay = new Map<string, Set<string>>(dates.map((d) => [isoDay(d), new Set<string>()]));

    // Every schedule overlapping the window, with its (non-removed) batch tickets. A schedule can span
    // several days, and a day can be covered by more than one schedule — hence sets, not counts.
    const schedules = await this.prisma.workSchedule.findMany({
      where: { seId, dateFrom: { lte: lastDate }, dateTo: { gte: firstDate } },
      select: {
        dateFrom: true,
        dateTo: true,
        batches: { select: { tickets: { where: { removedAt: null }, select: { ticketId: true } } } },
      },
    });

    for (const schedule of schedules) {
      const ticketIds = schedule.batches.flatMap((b) => b.tickets.map((t) => t.ticketId));
      if (ticketIds.length === 0) continue;
      for (const date of dates) {
        if (date < schedule.dateFrom || date > schedule.dateTo) continue;
        const bucket = assignedByDay.get(isoDay(date))!;
        for (const ticketId of ticketIds) bucket.add(ticketId);
      }
    }

    const allTicketIds = [...new Set([...assignedByDay.values()].flatMap((s) => [...s]))];

    // Closure events inside the window, as real instants: `ticket_events.at` is a Timestamptz, so the
    // bounds are the instants IST midnight occurred — not the UTC-midnight DATE form above (#204).
    const windowStart = new Date(firstDate.getTime() - IST_OFFSET_MS);
    const windowEnd = new Date(lastDate.getTime() + DAY_MS - IST_OFFSET_MS);
    const closures =
      allTicketIds.length === 0
        ? []
        : await this.prisma.ticketEvent.findMany({
            where: {
              ticketId: { in: allTicketIds },
              toState: { in: COMPLETED_STATES },
              at: { gte: windowStart, lt: windowEnd },
            },
            select: { ticketId: true, at: true },
          });

    const completedByDay = new Map<string, Set<string>>(dates.map((d) => [isoDay(d), new Set<string>()]));
    for (const event of closures) {
      const day = isoDay(istDate(event.at));
      // Only counts on a day the ticket was actually this SE's — see `completed ⊆ assigned` above.
      // A ticket that reopened and re-closed contributes once per day, hence the set.
      if (assignedByDay.get(day)?.has(event.ticketId)) completedByDay.get(day)!.add(event.ticketId);
    }

    const series: MeWorkHistoryDay[] = dates.map((date) => {
      const day = isoDay(date);
      return { date: day, assigned: assignedByDay.get(day)!.size, completed: completedByDay.get(day)!.size };
    });

    return { days: series };
  }
}

/** A `?days=` query value is an unvalidated string off the wire — garbage, a negative, or 10,000 all
 *  fall back to something renderable rather than 500-ing or scanning a year of events. */
function clampDays(requested: number | undefined): number {
  if (requested == null || !Number.isFinite(requested)) return DEFAULT_DAYS;
  return Math.min(MAX_DAYS, Math.max(1, Math.floor(requested)));
}
