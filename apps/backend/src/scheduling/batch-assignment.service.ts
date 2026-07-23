import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  DAY_PLAN_NOTIFIER,
  type DayPlanNotifier,
  LoggingDayPlanNotifier,
} from './day-plan-notifier';
import { UNIQUE_ACTIVE_SCHEDULE_INDEX_STATUS, liveScheduleFilter } from './schedule-status';

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
  /**
   * #126 — set when the zone was NOT dispatched and why (recorded on the `dispatch_run_zones` row
   * instead of a silent `{0,0,0}`). `LOCK_CONTENDED` = a concurrent dispatch held the per-zone lock;
   * `SCHEDULE_CONFLICT: …` = a pre-existing ACTIVE schedule collided and the zone tx rolled back.
   */
  skipReason?: string | null;
  /** #126 — orphan SUGGESTED recs cleared after a rolled-back dispatch (ledger hygiene). */
  orphansCleared?: number;
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

      // Idempotency guard (belt to the `batch_assignment_tickets_one_active_per_ticket` braces): a
      // ticket already sitting in a LIVE batch (removed_at IS NULL) is never assigned a second time.
      // The recommender only selects UNASSIGNED tickets, so this should be empty in normal flow — it
      // is the defence for a raced/retried dispatch. Such recs are still CONSUMED below (so they don't
      // re-loop) but produce no schedule/batch/ticket. The DB partial-unique remains the final backstop.
      const alreadyAssigned = new Set(
        recs.length === 0
          ? []
          : (
              await tx.batchAssignmentTicket.findMany({
                where: { ticketId: { in: recs.map((r) => r.ticketId) }, removedAt: null },
                select: { ticketId: true },
              })
            ).map((t) => t.ticketId),
      );
      const freshRecs = recs.filter((r) => !alreadyAssigned.has(r.ticketId));

      // se_id → plant_id → ticket_ids (insertion order = canonical order).
      const bySe = new Map<string, Map<bigint, string[]>>();
      for (const r of freshRecs) {
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
        // APPEND, don't collide: reuse the SE's existing live (se, zone, day) schedule — an earlier
        // dispatch run today, or a ZM_MANUAL plan — instead of creating a second one (which would P2002
        // on `work_schedules_one_active_per_se_zone_day` and roll back the whole zone, dropping every
        // fresh recommendation). New stops continue after the schedule's current last stop; a fresh
        // schedule is created only when the SE has none. The unique index stays the final safety net.
        //
        // #153 — "live" must include OVERRIDDEN, and here the index canNOT be the safety net: it is
        // partial on `status = 'ACTIVE'`, so once a ZM override flipped the schedule this lookup missed
        // it, the create succeeded unopposed, and the SE ended the day with two day-plans. Oldest-first
        // so an SE carrying legacy duplicates keeps getting the plan they are already executing.
        const existing = await tx.workSchedule.findFirst({
          where: { seId, zoneId, dateFrom: opts.dateFrom, ...liveScheduleFilter() },
          orderBy: { scheduleId: 'asc' },
          select: { scheduleId: true },
        });
        const scheduleId =
          existing?.scheduleId ??
          (
            await tx.workSchedule.create({
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
              select: { scheduleId: true },
            })
          ).scheduleId;
        schedules++; // schedules touched by this run (created or appended-to)

        // Continue stop numbering after the schedule's current last stop so an appended plan preserves
        // the route the SE may already be executing — new work lands at the end, never reordering it.
        const lastStop = await tx.plantBatchAssignment.aggregate({
          where: { scheduleId },
          _max: { stopSequence: true },
        });
        let stopSequence = lastStop._max.stopSequence ?? 0;
        let scheduleTickets = 0;
        for (const [plantId, ticketIds] of this.orderPlantStops(byPlant)) {
          stopSequence++;
          // A fresh batch per run (stamped with run_id) even when the plant already has a stop from an
          // earlier run — keeps run-attribution clean (the transparency ledger reads batch.run_id) and
          // sidesteps mutating another run's batch. Duplicate TICKETS are already excluded above.
          const batch = await tx.plantBatchAssignment.create({
            data: { scheduleId, plantId, seId, status: 'AUTO_ASSIGNED', stopSequence, runId: opts.runId ?? null },
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
              // #146 — clear any spent deferral as the ticket is re-dispatched. The date has done its
              // job; leaving it set would keep a stale "was deferred" marker on live work. The batch
              // row's `deferred_to_date` is the durable record of what the ZM did (scorecard AC#7).
              data: { assignmentState: 'FORMALLY_ASSIGNED', deferredUntil: null },
            });
            tickets++;
            scheduleTickets++;
          }
        }

        notifications.push({ seId, scheduleId, zoneId, stops: stopSequence, tickets: scheduleTickets });
      }

      // Consume ALL recommendations read (Issue 100): flip SUGGESTED → DISPATCHED so a re-invoke
      // (retry, double-click, second instance) no longer re-reads and re-dispatches the same set. This
      // includes the idempotency-guarded duplicates — they are done with, not to be re-evaluated.
      if (recs.length) {
        await tx.recommendation.updateMany({
          where: { recommendationId: { in: recs.map((r) => r.recommendationId) } },
          data: { status: 'DISPATCHED' },
        });
      }

      return { schedules, batches, tickets };
      });
    } catch (e) {
      // #126 — the zone tx rolled back. Rollback-cause-agnostic FIRST step: clear THIS run's orphan
      // SUGGESTED recs for the zone so they can never poison a future run (the recommender wrote them
      // outside this tx and the rollback did not touch them). Keyed by (run_id, zone) so a concurrent
      // run's recs are never deleted; trace rows cascade.
      const orphansCleared = await this.clearRunZoneOrphans(opts.runId, zoneId);
      if ((e as { code?: string }).code === 'P2002') {
        // Uniqueness backstop lost the race (Issue 100 AC#4): a pre-existing ACTIVE schedule for one of
        // this zone's SEs collided (e.g. a ZM manual schedule). Record WHY on the ledger zone row —
        // never a silent no-op — and return so the run continues with the rest of its zones.
        const conflictSeIds = await this.conflictingScheduleSeIds(zoneId, opts.dateFrom);
        const who = conflictSeIds.length ? `SE(s) ${conflictSeIds.join(', ')}` : 'an existing schedule';
        const skipReason = `SCHEDULE_CONFLICT: ${who} already hold an ACTIVE schedule for this zone/day; ${orphansCleared} orphan SUGGESTED rec(s) cleared`;
        this.logger.warn(`dispatch for zone ${zoneId} skipped — ${skipReason}`);
        return { ...skipped, skipReason, orphansCleared };
      }
      // Any other rollback (deadlock / statement timeout / …): orphans are already cleared; rethrow so
      // the dispatch run records the zone error (it is a genuine failure, not a benign skip).
      this.logger.error(
        `dispatch for zone ${zoneId} rolled back (${orphansCleared} orphan SUGGESTED cleared): ${e instanceof Error ? e.message : String(e)}`,
      );
      throw e;
    }

    // Lock was held by a concurrent dispatch — nothing was written; that dispatch owns this zone's
    // recs, so leave them (do NOT clean) and record the contended-lock reason on the zone row.
    if (summary === null) return { ...skipped, skipReason: 'LOCK_CONTENDED' };

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

  /**
   * #126 — SEs already holding an ACTIVE schedule for (zone, day): the conflict source behind a
   * dispatch P2002 on `work_schedules_one_active_per_se_zone_day`. Reported on the ledger zone row so
   * the skip names WHO blocked it (per-SE isolation of the conflict is #127).
   *
   * #153 note — this one is deliberately NOT widened to the live set. It answers "which rows did the
   * database refuse to duplicate?", and that index is partial on `status = 'ACTIVE'`; naming overridden
   * schedules here would blame rows that cannot have caused the collision.
   */
  private async conflictingScheduleSeIds(zoneId: bigint, dateFrom: Date): Promise<string[]> {
    const rows = await this.prisma.workSchedule.findMany({
      where: { zoneId, dateFrom, status: UNIQUE_ACTIVE_SCHEDULE_INDEX_STATUS },
      select: { seId: true },
    });
    return [...new Set(rows.map((r) => r.seId))];
  }

  /**
   * #126 — clear THIS run's orphan SUGGESTED recs for one zone after a rolled-back dispatch. Keyed
   * `(run_id, zone, status='SUGGESTED')` so a concurrent run's recs are never touched; trace rows
   * cascade. A no-op when the caller supplied no `runId` (nothing to key on safely — the recommender's
   * finalized/null-run sweep collects those on the next run).
   */
  private async clearRunZoneOrphans(runId: bigint | undefined, zoneId: bigint): Promise<number> {
    if (runId === undefined) return 0;
    const { count } = await this.prisma.recommendation.deleteMany({
      where: { runId, status: 'SUGGESTED', ticket: { plant: { zoneId } } },
    });
    return count;
  }
}
