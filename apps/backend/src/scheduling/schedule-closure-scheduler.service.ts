import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { type TicketStatus } from '../generated/prisma/enums';
import { istDate } from '../common/ist-day';
import { PrismaService } from '../prisma/prisma.service';
import { BUSINESS_TIMEZONE } from './dispatch-cron';
import type { TickClaimant } from './cron-tick-claim';
import { dispatchZoneLockKey } from './dispatch-zone-lock';
import { REMOVAL_REASONS } from './removal-reason';
import { liveScheduleFilter } from './schedule-status';

/**
 * Default cron for the schedule-closure backstop — daily at 04:00 **IST** (#240), i.e. ahead of the
 * 04:30 eligibility refresh and the 05:00 IST dispatch tick, so yesterday's plans are terminal before
 * today's are built. Overridable via `SCHEDULE_CLOSURE_CRON`, which is likewise read as an **IST**
 * expression — the job is registered with `timeZone: BUSINESS_TIMEZONE`, so an operator writing "4"
 * gets 04:00 in the business timezone on any host.
 */
export const DEFAULT_SCHEDULE_CLOSURE_CRON = '0 4 * * *';

/** #263 — the registered cron-job name, shared by the decorator and the tick claim. */
export const SCHEDULE_CLOSURE_JOB_NAME = 'schedule-closure';

export interface ScheduleClosureConfig {
  /** Shares the pipeline master switch — `BUSINESS_SWEEPS_ENABLED === 'true'`. Default OFF. */
  enabled: boolean;
  closureCron: string;
}

/** Resolve the master switch + cron in one place; anything but the literal 'true' stays OFF. */
export function readScheduleClosureConfig(env: NodeJS.ProcessEnv = process.env): ScheduleClosureConfig {
  return {
    enabled: env.BUSINESS_SWEEPS_ENABLED === 'true',
    closureCron: env.SCHEDULE_CLOSURE_CRON?.trim() || DEFAULT_SCHEDULE_CLOSURE_CRON,
  };
}

/**
 * What the tick reports — a cron body NEVER throws out of the cron context.
 *
 * `recycled` is #242's release volume: how many dispatched-but-unworked tickets this tick handed back
 * to the pool. It is reported rather than merely logged because it is the one figure that makes the new
 * lifecycle auditable from outside — a night that releases an order of magnitude more than usual is a
 * signal, and a silent recycler would have nowhere to show it.
 */
export type ScheduleClosureOutcome =
  | { ran: true; closed: number; zonesSkipped: number; recycled: number }
  | { ran: false; reason: 'DISABLED' | 'RUN_IN_PROGRESS' | 'TICK_CLAIMED' | 'ERROR' };

/** What one zone's closure did — `null` for the whole result when the zone's dispatch holds the lock. */
interface ZoneClosure {
  closed: number;
  recycled: number;
}

/**
 * Ticket statuses that mean the day's work on that ticket is over — the same resolved set
 * `DeviceService.listDevices` excludes when it looks for a device's *open* ticket. A schedule none of
 * whose live tickets is outside this set finished; anything else was only partly worked.
 */
const RESOLVED_TICKET_STATUSES: readonly TicketStatus[] = [
  'CLOSED',
  'CLOSED_AUTO_RECOVERY',
  'CLOSED_NON_OPERATIONAL',
  'FAILED_VERIFICATION',
  'FAILED_ACTIVATION',
  'FAILED_RECOVERY',
  'RECEIVED_AT_WAREHOUSE',
];

/**
 * Issue 147 slice 2 — the closing transition the work-schedule lifecycle never had.
 *
 * `AUTO_ASSIGNED → OVERRIDDEN → COMPLETED | PARTIAL` is the business workflow
 * (`fsm-business-technical-workflow.md:1913`), but nothing wrote the terminal half, so schedules
 * accreted as permanently live — 190 across 64 SEs when the 07-28 readiness pass measured it — and
 * every one stayed eligible to be served as a day plan. Slice 1's date predicate makes the *read* safe;
 * this makes the *state* honest, so reports and capacity accounting stop counting finished days as live.
 *
 * It sits beside `DispatchSchedulerService` rather than joining the #108 business sweeps, following the
 * `PlantEligibilityRefreshScheduler` precedent: master switch re-checked every tick, a single-in-flight
 * guard turning an overlapping tick into a logged skip, and a structured outcome instead of a throw.
 *
 * **Why it locks.** #127's APPEND reads an SE's existing live schedule and then extends it, all inside
 * one transaction. A closer that flipped that schedule terminal in between would strand the stops the
 * APPEND had just written on a closed plan — and only under concurrency, so nothing would fail loudly.
 * Each zone is therefore closed under the same `dispatch_zone_<id>` advisory lock the dispatch holds,
 * taken with the *try* variant: a zone whose dispatch is in flight is skipped, not waited on. Skipping
 * is safe precisely because this is a backstop — the next tick collects it, and a plan that stays live a
 * few hours longer is the benign direction to fail.
 *
 * Contention runs both ways, and the other direction is the costly one: a dispatch that finds the lock
 * held records `LOCK_CONTENDED` and skips the zone for that run, leaving its SEs without a plan for the
 * day. Two things keep that off the table rather than one — the crons are an hour apart **in the same
 * timezone** (04:00 vs 05:00 IST; #240 pinned `timeZone` here, which is what makes that hour real
 * rather than host-dependent), and each zone is closed in its own short transaction, so the lock is
 * held for a few queries rather than for the length of the tick. Anything added here that widens that
 * window (a per-schedule fan-out, an unbounded scan under one lock) trades a stale plan for a missing
 * one.
 */
@Injectable()
export class ScheduleClosureScheduler {
  private readonly logger = new Logger(ScheduleClosureScheduler.name);
  private readonly config: ScheduleClosureConfig;
  private inFlight = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly claims: TickClaimant,
    config?: Partial<ScheduleClosureConfig>,
  ) {
    this.config = { ...readScheduleClosureConfig(), ...config };
  }

  @Cron(readScheduleClosureConfig().closureCron, { name: SCHEDULE_CLOSURE_JOB_NAME, timeZone: BUSINESS_TIMEZONE })
  async closeTick(opts: { now?: Date } = {}): Promise<ScheduleClosureOutcome> {
    if (!this.config.enabled) return { ran: false, reason: 'DISABLED' };
    if (this.inFlight) {
      this.logger.log('schedule closure skipped — a closure tick is already in flight');
      return { ran: false, reason: 'RUN_IN_PROGRESS' };
    }
    this.inFlight = true;
    try {
      const now = opts.now ?? new Date();
      // #263 — claimed before the zone scan, so the losing instance never takes the per-zone advisory
      // locks. That matters more here than anywhere else: a second closer contending for
      // `dispatch_zone_<id>` is exactly what makes a dispatch record LOCK_CONTENDED and leave a zone's
      // SEs without a day plan (see the class docstring).
      if (!(await this.claims.claimTickOrLog(SCHEDULE_CLOSURE_JOB_NAME, now))) {
        return { ran: false, reason: 'TICK_CLAIMED' };
      }
      const today = istDate(now);

      // Zone-at-a-time, because the lock is per zone: one zone mid-dispatch must not hold up the rest.
      const zones = await this.prisma.workSchedule.findMany({
        where: { dateTo: { lt: today }, ...liveScheduleFilter() },
        distinct: ['zoneId'],
        select: { zoneId: true },
      });

      let closed = 0;
      let zonesSkipped = 0;
      let recycled = 0;
      for (const { zoneId } of zones) {
        const outcome = await this.closeZone(zoneId, today, now);
        if (outcome === null) zonesSkipped++;
        else {
          closed += outcome.closed;
          recycled += outcome.recycled;
        }
      }
      if (closed || zonesSkipped) {
        this.logger.log(
          `schedule closure — ${closed} schedule(s) closed, ${recycled} ticket(s) recycled, ${zonesSkipped} zone(s) skipped (locked)`,
        );
      }
      return { ran: true, closed, zonesSkipped, recycled };
    } catch (e) {
      this.logger.error(`schedule closure failed: ${e instanceof Error ? e.message : String(e)}`);
      return { ran: false, reason: 'ERROR' };
    } finally {
      this.inFlight = false;
    }
  }

  /** Closes one zone's past-dated schedules. `null` = the zone's dispatch holds the lock; try next tick. */
  private async closeZone(zoneId: bigint, today: Date, now: Date): Promise<ZoneClosure | null> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtext(${dispatchZoneLockKey(zoneId)})) AS locked`;
      if (!locked[0]?.locked) {
        this.logger.log(`schedule closure for zone ${zoneId} skipped — a dispatch holds the lock`);
        return null;
      }

      // Re-read inside the lock: between the zone scan and here a dispatch may have come and gone.
      const stale = await tx.workSchedule.findMany({
        where: { zoneId, dateTo: { lt: today }, ...liveScheduleFilter() },
        select: { scheduleId: true },
      });
      if (stale.length === 0) return { closed: 0, recycled: 0 };
      const staleIds = stale.map((s) => s.scheduleId);

      // A schedule is PARTIAL if any still-assigned ticket was left unresolved; removed tickets
      // (`removedAt`) are a ZM's withdrawal, not unfinished work, so they never hold a day open.
      const unfinished = await tx.plantBatchAssignment.findMany({
        where: {
          scheduleId: { in: staleIds },
          tickets: {
            some: { removedAt: null, ticket: { status: { notIn: [...RESOLVED_TICKET_STATUSES] } } },
          },
        },
        distinct: ['scheduleId'],
        select: { scheduleId: true },
      });
      const partialIds = unfinished.map((b) => b.scheduleId);
      const completedIds = staleIds.filter((id) => !partialIds.includes(id));

      if (partialIds.length) {
        await tx.workSchedule.updateMany({ where: { scheduleId: { in: partialIds } }, data: { status: 'PARTIAL' } });
      }
      if (completedIds.length) {
        await tx.workSchedule.updateMany({
          where: { scheduleId: { in: completedIds } },
          data: { status: 'COMPLETED' },
        });
      }

      const recycled = await this.recycle(tx, staleIds, now);
      return { closed: staleIds.length, recycled };
    });
  }

  /**
   * #242 — the closing transition the *assignment* lifecycle never had, and the reason a ticket could
   * never be dispatched a third time.
   *
   * Flipping the schedule terminal (above) left the batch row live and the ticket `FORMALLY_ASSIGNED`,
   * which put an unworked ticket in a **double limbo**: the recommender selects `OPEN` + `UNASSIGNED`
   * only, so it could not see the ticket; and every day-plan read requires a *live* schedule, so
   * neither could the SE. The ticket belonged to nobody, permanently. 4,983 OPEN tickets were sitting
   * that way in the dev mirror when this was measured, and the maximum assignment attempts any ticket
   * had ever reached was 2 — every one of those via a human bulk-unassign.
   *
   * Two writes, in this order, both set-based:
   *
   *  1. **Recycle** — end the assignment window on every still-live row whose ticket is unresolved, and
   *     hand the ticket back to the pool. `removed_by` is NULL and the reason is `PLAN_EXPIRED`: with
   *     #241's column, "the system did this" and "because the day ended" are separately recorded, which
   *     is what lets #244 count this window as an *attempt that was never reached* rather than as an
   *     administrative withdrawal.
   *  2. **Backstop** — a row still live on an *already-resolved* ticket is stamped `RESOLVED_AT_CLOSURE`
   *     and the ticket is left alone. #241 gave every resolving path its own departure stamp, so this
   *     should be rare; it exists because the leak it covers is the #241 class — a live row on a closed
   *     ticket keeps rendering on day plans as work to do — and a backstop that only fires on the cases
   *     nobody anticipated is exactly the one worth having. Resolved work is never unassigned: returning
   *     finished tickets to the pool is the one thing a recycler must not do.
   *
   * **Why the ticket ids are read first.** `updateMany` returns a count, not rows, and write 1's second
   * half needs the very tickets its first half stamped. One read + two writes stays inside the lock
   * budget (see the class docstring — a fan-out here costs some zone its day plan tomorrow), and the
   * read is the same shape the PARTIAL computation above already performs.
   *
   * **Why nothing here touches `deferred_until`.** A ticket may be both recycled and waiting on a
   * vehicle (#246): `UNASSIGNED` says *something* may re-plan it, `deferred_until` says *not yet*. The
   * sweep writes only the first, so the wait survives the plan expiring.
   *
   * Idempotent by construction: the second pass matches nothing, because `removed_at IS NULL` is the
   * filter. Under concurrency the partial unique `batch_assignment_tickets_one_active_per_ticket` is
   * the backstop — this method can only ever *remove* liveness, never create a second live row.
   */
  private async recycle(
    tx: Pick<PrismaService, 'batchAssignmentTicket' | 'ticket'>,
    staleIds: bigint[],
    now: Date,
  ): Promise<number> {
    const live = await tx.batchAssignmentTicket.findMany({
      where: { removedAt: null, batch: { scheduleId: { in: staleIds } } },
      select: { id: true, ticketId: true, ticket: { select: { status: true } } },
    });
    if (live.length === 0) return 0;

    const resolved = new Set<string>(RESOLVED_TICKET_STATUSES);
    const unresolved = live.filter((r) => !resolved.has(r.ticket.status));
    const stragglers = live.filter((r) => resolved.has(r.ticket.status));

    // `removedAt: null` is repeated in both writes even though the read already filtered on it, and
    // that is not redundancy. `OverrideService` takes **no** advisory lock, so a ZM withdrawing a
    // ticket at 04:00 can commit between this method's read and its writes; keying only on `id` would
    // then overwrite their actor and reason with a system stamp — and #244 reads that reason as a
    // predicate, so the mistake would be an operational reclassification rather than a visible one.
    // With the predicate, a row somebody else has already closed is simply left alone.
    if (stragglers.length) {
      await tx.batchAssignmentTicket.updateMany({
        where: { id: { in: stragglers.map((r) => r.id) }, removedAt: null },
        data: { removedAt: now, removedBy: null, removalReason: REMOVAL_REASONS.RESOLVED_AT_CLOSURE },
      });
    }
    if (unresolved.length === 0) return 0;

    const recycled = await tx.batchAssignmentTicket.updateMany({
      where: { id: { in: unresolved.map((r) => r.id) }, removedAt: null },
      data: { removedAt: now, removedBy: null, removalReason: REMOVAL_REASONS.PLAN_EXPIRED },
    });
    // Scoped to tickets that have no live assignment **left**, which after the statement above is the
    // set this sweep just released. The partial unique makes a second live row impossible, so this can
    // only ever exclude a ticket some concurrent path re-assigned — and unassigning one of those would
    // manufacture the exact `FORMALLY_ASSIGNED`-with-no-live-row inconsistency #243 exists to clean.
    await tx.ticket.updateMany({
      where: {
        ticketId: { in: unresolved.map((r) => r.ticketId) },
        batchTickets: { none: { removedAt: null } },
      },
      data: { assignmentState: 'UNASSIGNED' },
    });
    // The statement's own count, not `unresolved.length`: they differ by exactly the rows a concurrent
    // writer closed first, and reporting a release that did not happen is the failure mode this figure
    // exists to prevent.
    return recycled.count;
  }
}
