import { istDate } from '../common/ist-day';
import type { PrismaService } from '../prisma/prisma.service';
import { liveScheduleFilter } from './schedule-status';

/** The narrow slice of the client this helper touches — a transaction client satisfies it too. */
type CommittedDayLoadClient = Pick<PrismaService, 'batchAssignmentTicket'>;

/**
 * An SE's **committed day load** for a calendar day — #269's one definition of "committed".
 *
 * The unit is a live day-plan stop: a `batch_assignment_tickets` row still `removed_at IS NULL`, on a
 * live work schedule (#153's `LIVE_SCHEDULE_STATUSES` — an OVERRIDDEN plan is still today's work)
 * whose `[dateFrom, dateTo]` range covers `day`. Counted across **every** zone and every run, because
 * `daily_capacity` caps the engineer's whole day rather than one zone-run: a floating multi-plant SE
 * seeded at 0 per zone was dispatched up to capacity in each zone the daily loop visited.
 *
 * **Why this is a module and not a private method.** It was three methods. `RecommenderService`
 * enforced capacity with this predicate; `EngineersQueryService.activeTicketCountBySe` answered the
 * same question with **no date filter** (so a multi-day plan's whole range counted against today) plus
 * a batch-status filter the enforcement path does not apply; and `ZmScheduleRow.ticketCount` counted
 * one schedule rather than one day. Nothing rendered any of them beside `daily_capacity`, so the
 * disagreement was invisible. #269 renders it — and a number a manager reads as "can this engineer
 * carry it?" has to be the number the engine will actually enforce, so display and enforcement now
 * share this function rather than agreeing by coincidence. `capacity-overload-visibility.e2e-spec.ts`
 * asserts the agreement through both public seams rather than trusting the shared import.
 *
 * **No batch-status filter, deliberately.** The recommender — the enforcement authority — has never
 * applied one, and a PARTIAL batch's unfinished tickets are exactly the work that still burns the
 * engineer's day. A COMPLETED batch's tickets are resolved, and since #178 a resolved ticket's row is
 * retired at closure, so `removed_at IS NULL` already excludes them at the right boundary.
 *
 * `day` is normalised with {@link istDate} here rather than at each call site: the operating day is
 * IST (CONTEXT.md Decisions §19) and `date_from`/`date_to` are `@db.Date`, so the comparison value
 * must be UTC midnight of the IST calendar date. `istDate` is idempotent, so a caller that already
 * normalised (the recommender's `targetDay`) is unaffected.
 *
 * @returns se_id → committed stop count. SEs with nothing committed are **absent**, not zero — read
 *   it as `load.get(seId) ?? 0`.
 */
export async function committedDayLoad(
  prisma: CommittedDayLoadClient,
  day: Date,
  opts: { seIds?: string[] } = {},
): Promise<Map<string, number>> {
  const plan = await committedDayPlan(prisma, day, opts);
  const load = new Map<string, number>();
  for (const [seId, entry] of plan) load.set(seId, entry.count);
  return load;
}

/** One SE's committed day, as both figures the run needs: how much, and where. */
export interface CommittedDayEntry {
  /** Live day-plan stops — the figure {@link committedDayLoad} returns and `daily_capacity` caps. */
  count: number;
  /** The distinct plants those stops are at, as `plant_id` strings. */
  plants: Set<string>;
}

/**
 * The same read as {@link committedDayLoad}, keeping the plants as well as the count — #266's Q-A.
 *
 * The Plant Cluster Multiplier used to ask "has ANY SE been seeded at this plant this run", which is
 * one value per ticket applied to every candidate, so it cancelled out of every comparison between
 * them and could not influence a decision. Q-A makes it ask the question its name always implied:
 * **does THIS engineer already go to this plant today?** That is answerable from the rows already
 * being read here, so it is one widened `select`, not a second query pattern — the per-run cost NEW-A1
 * established is unchanged, and clustering and capacity are seeded from the *same* rows rather than
 * from two notions of "where is this engineer going today" that could drift.
 *
 * `committedDayLoad` is re-expressed over this rather than duplicated, so the two can never disagree
 * about which stops count — the whole reason #269 collapsed three counters into one.
 */
export async function committedDayPlan(
  prisma: CommittedDayLoadClient,
  day: Date,
  opts: { seIds?: string[] } = {},
): Promise<Map<string, CommittedDayEntry>> {
  const target = istDate(day);
  const rows = await prisma.batchAssignmentTicket.findMany({
    where: {
      removedAt: null,
      batch: {
        ...(opts.seIds ? { seId: { in: opts.seIds } } : {}),
        schedule: { ...liveScheduleFilter(), dateFrom: { lte: target }, dateTo: { gte: target } },
      },
    },
    select: { batch: { select: { seId: true, plantId: true } } },
  });
  const plan = new Map<string, CommittedDayEntry>();
  for (const r of rows) {
    const entry = plan.get(r.batch.seId) ?? { count: 0, plants: new Set<string>() };
    entry.count += 1;
    entry.plants.add(String(r.batch.plantId));
    plan.set(r.batch.seId, entry);
  }
  return plan;
}
