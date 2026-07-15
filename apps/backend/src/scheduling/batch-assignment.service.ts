import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
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
  /** Dispatch-run ledger id (transparency feature) — stamped on created schedules, observe-only. */
  runId?: bigint;
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
  private readonly logger = new Logger(BatchAssignmentService.name);
  private readonly notifier: DayPlanNotifier;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(DAY_PLAN_NOTIFIER) notifier?: DayPlanNotifier,
  ) {
    this.notifier = notifier ?? new LoggingDayPlanNotifier();
  }

  async dispatchForZone(zoneId: bigint, opts: DispatchOptions): Promise<DispatchSummary> {
    const now = opts.now ?? new Date();

    // Notifier events are collected inside the tx and fired only AFTER commit — a rolled-back plan must
    // never announce "Day Plan is live", and the notification I/O has no place inside a DB transaction.
    const notifications: Parameters<DayPlanNotifier['dayPlanDispatched']>[0][] = [];

    const skipped: DispatchSummary = { schedules: 0, batches: 0, tickets: 0 };

    let summary: DispatchSummary | null;
    try {
      summary = await this.prisma.$transaction(async (tx) => {
      // Per-zone advisory lock (Issue 100) — the primary serializer: two concurrent dispatches of the
      // same zone can't both proceed, so one ticket is never suggested-then-dispatched to two SEs. The
      // partial-unique indexes are the durable cross-connection backstop if this is ever bypassed. Same
      // txn-scoped idiom as SnapshotRunService/MasterSyncRunService (a non-blocking `try` lock).
      const locked = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtext(${'dispatch_zone_' + zoneId.toString()})) AS locked`;
      if (!locked[0]?.locked) {
        this.logger.log(`dispatch for zone ${zoneId} skipped — another dispatch holds the lock`);
        return null;
      }

      // SUGGESTED recommendations in this zone with a chosen SE, in canonical processing order.
      const recs = await tx.recommendation.findMany({
        where: { status: 'SUGGESTED', seId: { not: null }, ticket: { plant: { zoneId } } },
        select: { recommendationId: true, ticketId: true, seId: true, ticket: { select: { plantId: true } } },
        orderBy: { processingRank: 'asc' },
      });

      // se_id → plant_id → ticket_ids (insertion order = canonical order).
      const bySe = new Map<string, Map<bigint, string[]>>();
      for (const r of recs) {
        const seId = r.seId!;
        const plantId = r.ticket.plantId;
        const byPlant = bySe.get(seId) ?? new Map<bigint, string[]>();
        const ticketList = byPlant.get(plantId) ?? [];
        ticketList.push(r.ticketId);
        byPlant.set(plantId, ticketList);
        bySe.set(seId, byPlant);
      }

      let schedules = 0;
      let batches = 0;
      let tickets = 0;

      for (const [seId, byPlant] of bySe) {
        const schedule = await tx.workSchedule.create({
          data: {
            seId,
            zoneId,
            dateFrom: opts.dateFrom,
            dateTo: opts.dateTo,
            status: 'ACTIVE',
            source: 'SYSTEM_GENERATED',
            dispatchedAt: now,
            runId: opts.runId ?? null,
          },
        });
        schedules++;

        let stopSequence = 0;
        let scheduleTickets = 0;
        for (const [plantId, ticketIds] of this.orderPlantStops(byPlant)) {
          stopSequence++;
          const batch = await tx.plantBatchAssignment.create({
            data: { scheduleId: schedule.scheduleId, plantId, seId, status: 'AUTO_ASSIGNED', stopSequence },
          });
          batches++;

          let sortOrder = 0;
          for (const ticketId of ticketIds) {
            sortOrder++;
            await tx.batchAssignmentTicket.create({
              data: { batchId: batch.batchId, ticketId, sortOrder },
            });
            // Committed work leaves the Shared Pool (Issue 12): the dispatched ticket is now a Formal
            // Assignment, not pickable secondary work (schema D6, LLD shared-pool partial index).
            await tx.ticket.update({
              where: { ticketId },
              data: { assignmentState: 'FORMALLY_ASSIGNED' },
            });
            tickets++;
            scheduleTickets++;
          }
        }

        notifications.push({ seId, scheduleId: schedule.scheduleId, zoneId, stops: stopSequence, tickets: scheduleTickets });
      }

      // Consume the dispatched recommendations (Issue 100): flip SUGGESTED → DISPATCHED so a re-invoke
      // (retry, double-click, second instance) no longer re-reads and re-dispatches the same set.
      if (recs.length) {
        await tx.recommendation.updateMany({
          where: { recommendationId: { in: recs.map((r) => r.recommendationId) } },
          data: { status: 'DISPATCHED' },
        });
      }

      return { schedules, batches, tickets };
      });
    } catch (e) {
      // Uniqueness backstop lost the race (Issue 100 AC#4): another dispatch already placed this work.
      // The designed outcome is a clean no-op, not a raw 500. Any other error propagates.
      if ((e as { code?: string }).code === 'P2002') {
        this.logger.warn(`dispatch for zone ${zoneId} lost a uniqueness race — treated as a no-op`);
        return skipped;
      }
      throw e;
    }

    // Lock was held by a concurrent dispatch — nothing was written, nothing to announce.
    if (summary === null) return skipped;

    // "Day Plan is live" — fires after commit, regardless of channel availability (Issue 11 AC#4); the
    // seam swaps to the Issue 03 notification spine without changing this dispatch contract.
    for (const event of notifications) {
      await this.notifier.dayPlanDispatched(event);
    }

    return summary;
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
