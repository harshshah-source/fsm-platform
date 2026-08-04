import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { type TicketStatus } from '../generated/prisma/enums';
import { istDate } from '../common/ist-day';
import { PrismaService } from '../prisma/prisma.service';
import { dispatchZoneLockKey } from './dispatch-zone-lock';
import { liveScheduleFilter } from './schedule-status';

/**
 * Default cron for the schedule-closure backstop — daily at 04:00 UTC, i.e. ahead of the 04:30
 * eligibility refresh and the 05:00 dispatch tick, so yesterday's plans are terminal before today's are
 * built. Overridable via `SCHEDULE_CLOSURE_CRON`.
 */
export const DEFAULT_SCHEDULE_CLOSURE_CRON = '0 4 * * *';

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

/** What the tick reports — a cron body NEVER throws out of the cron context. */
export type ScheduleClosureOutcome =
  | { ran: true; closed: number; zonesSkipped: number }
  | { ran: false; reason: 'DISABLED' | 'RUN_IN_PROGRESS' | 'ERROR' };

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
 * day. Two things keep that off the table rather than one — the crons are an hour apart (04:00 vs
 * 05:00), and each zone is closed in its own short transaction, so the lock is held for a few queries
 * rather than for the length of the tick. Anything added here that widens that window (a per-schedule
 * fan-out, an unbounded scan under one lock) trades a stale plan for a missing one.
 */
@Injectable()
export class ScheduleClosureScheduler {
  private readonly logger = new Logger(ScheduleClosureScheduler.name);
  private readonly config: ScheduleClosureConfig;
  private inFlight = false;

  constructor(
    private readonly prisma: PrismaService,
    config?: Partial<ScheduleClosureConfig>,
  ) {
    this.config = { ...readScheduleClosureConfig(), ...config };
  }

  @Cron(readScheduleClosureConfig().closureCron, { name: 'schedule-closure' })
  async closeTick(opts: { now?: Date } = {}): Promise<ScheduleClosureOutcome> {
    if (!this.config.enabled) return { ran: false, reason: 'DISABLED' };
    if (this.inFlight) {
      this.logger.log('schedule closure skipped — a closure tick is already in flight');
      return { ran: false, reason: 'RUN_IN_PROGRESS' };
    }
    this.inFlight = true;
    try {
      const today = istDate(opts.now ?? new Date());

      // Zone-at-a-time, because the lock is per zone: one zone mid-dispatch must not hold up the rest.
      const zones = await this.prisma.workSchedule.findMany({
        where: { dateTo: { lt: today }, ...liveScheduleFilter() },
        distinct: ['zoneId'],
        select: { zoneId: true },
      });

      let closed = 0;
      let zonesSkipped = 0;
      for (const { zoneId } of zones) {
        const count = await this.closeZone(zoneId, today);
        if (count === null) zonesSkipped++;
        else closed += count;
      }
      if (closed || zonesSkipped) {
        this.logger.log(`schedule closure — ${closed} schedule(s) closed, ${zonesSkipped} zone(s) skipped (locked)`);
      }
      return { ran: true, closed, zonesSkipped };
    } catch (e) {
      this.logger.error(`schedule closure failed: ${e instanceof Error ? e.message : String(e)}`);
      return { ran: false, reason: 'ERROR' };
    } finally {
      this.inFlight = false;
    }
  }

  /** Closes one zone's past-dated schedules. `null` = the zone's dispatch holds the lock; try next tick. */
  private async closeZone(zoneId: bigint, today: Date): Promise<number | null> {
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
      if (stale.length === 0) return 0;
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
      return staleIds.length;
    });
  }
}
