import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  DAY_PLAN_NOTIFIER,
  type DayPlanNotifier,
  LoggingDayPlanNotifier,
} from './day-plan-notifier';
import { ADD_SOURCES } from './add-source';
import { resolveCoverageForPlants } from './coverage-at-assign';
import { drainRows, queueDayPlanDispatched } from './day-plan-notification-outbox';
import { ZONE_LOCK_TIMEOUT_MS, dispatchZoneLockKey } from './dispatch-zone-lock';
import { type SeSkip, describeSeSkip } from './se-skip';
import { UNIQUE_ACTIVE_SCHEDULE_INDEX_STATUS, liveScheduleFilter } from './schedule-status';

export interface DispatchOptions {
  /** Day Plan coverage start (Schedule Cadence: daily → dateFrom === dateTo). */
  dateFrom: Date;
  dateTo: Date;
  now?: Date;
  /** Dispatch-run ledger id (transparency feature) — stamped on created schedules, observe-only. */
  runId?: bigint;
}

export type { SeSkip };

export interface DispatchSummary {
  schedules: number;
  batches: number;
  tickets: number;
  /**
   * #126 — set when the WHOLE zone was not dispatched and why (recorded on the `dispatch_run_zones`
   * row instead of a silent `{0,0,0}`).
   *
   * #262 narrowed what may appear here. It is now reserved for **whole-zone** conditions — today only
   * `LOCK_CONTENDED`, a zone owned by a concurrent closure or bulk-unassign. A single SE's failure is
   * no longer a zone-level event and appears in {@link seSkips} instead; before this, one SE's
   * collision produced a zone-wide `SCHEDULE_CONFLICT` that named a skip which had not happened.
   */
  skipReason?: string | null;
  /** #126 — orphan SUGGESTED recs cleared after a failed dispatch (ledger hygiene). */
  orphansCleared?: number;
  /** #262 — per-SE failures, contained. Absent when every SE with work committed. */
  seSkips?: SeSkip[];
}

/**
 * The BatchAssignmentWorker (LLD §13.1 step 6, Issue 11). Turns the Recommender's SUGGESTED
 * recommendations for a zone into a dispatched Day Plan: one ACTIVE WorkSchedule per SE, the SE's
 * tickets grouped into one AUTO_ASSIGNED Plant-wise Batch Assignment per plant, and the batch's
 * tickets. Dispatched directly — no approval gate (Decision §7, ADR-0007/0019 superseded); the ZM
 * overrides post-hoc.
 *
 * **#262 — the write unit is the SE, not the zone.** This used to be a single transaction spanning
 * every SE in the zone, which had three consequences that only appear in production: one conflict
 * rolled back everybody's day plan; transaction duration grew with the zone at ~3 round-trips per
 * ticket, against an interactive-transaction budget of 5 s that nobody had chosen; and recommendation
 * consumption was one zone-wide flip at the end, so a concurrent claimer collided instead of simply
 * not seeing the rows. Now each SE gets its own transaction, which claims **that SE's** recommendation
 * rows with `SELECT … FOR UPDATE SKIP LOCKED`, and one SE's failure costs that SE only.
 */
@Injectable()
export class BatchAssignmentService {
  private readonly logger = new Logger(BatchAssignmentService.name);
  private readonly notifier: DayPlanNotifier;

  /**
   * #262 — how long a per-SE transaction waits for the zone advisory lock. Overridable through the
   * constructor rather than the environment, per #182 R5: a spec that needs a different value passes
   * it here, and no developer's `.env` can change what the suite does.
   */
  private readonly zoneLockTimeoutMs: number;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(DAY_PLAN_NOTIFIER) notifier?: DayPlanNotifier,
    // `@Optional()` is load-bearing, not decoration: without it Nest treats the parameter as an
    // injection token and fails to resolve the whole SchedulingModule at boot.
    @Optional() config?: { zoneLockTimeoutMs?: number },
  ) {
    this.notifier = notifier ?? new LoggingDayPlanNotifier();
    this.zoneLockTimeoutMs = config?.zoneLockTimeoutMs ?? ZONE_LOCK_TIMEOUT_MS;
  }

  async dispatchForZone(zoneId: bigint, opts: DispatchOptions): Promise<DispatchSummary> {
    const now = opts.now ?? new Date();

    // #264 — the outbox row IS the durable "Day Plan is live" intent, written inside each SE's own
    // per-SE transaction (below) so it commits with the plan or not at all. Only the row ids are
    // collected here; delivery is attempted post-commit, once every SE transaction has settled — a
    // rolled-back plan must never announce "Day Plan is live" (it never wrote a row), and notification
    // I/O has no place inside a DB transaction.
    const outboxIds: bigint[] = [];
    const seSkips: SeSkip[] = [];
    let schedules = 0;
    let batches = 0;
    let tickets = 0;

    // Read OUTSIDE any transaction: only *which* SEs have work. The rows themselves are re-read and
    // claimed inside each SE's own transaction, so this list going stale is harmless — an SE whose
    // work vanished simply claims nothing.
    const seIds = await this.sesWithSuggestions(zoneId);
    if (seIds.length === 0) return { schedules: 0, batches: 0, tickets: 0 };

    for (const seId of seIds) {
      try {
        const out = await this.dispatchForSe(zoneId, seId, opts, now, outboxIds);
        schedules += out.schedules;
        batches += out.batches;
        tickets += out.tickets;
      } catch (e) {
        const skip = describeSeSkip(seId, e);
        seSkips.push(skip);
        this.logger.warn(`dispatch for zone ${zoneId}, SE ${seId} skipped — ${skip.reason}`);
      }
    }

    // #126/#262 — leftover SUGGESTED rows belonging to the SEs whose transaction failed, cleared so a
    // rolled-back attempt can never poison a future run. Deliberately scoped to those SEs and not to
    // the whole zone: a row this dispatch could not SEE is a row somebody else has claimed
    // (SKIP LOCKED), and deleting it would be taking work out from under its owner.
    const orphansCleared = await this.clearFailedSeOrphans(opts.runId, zoneId, seSkips.map((s) => s.seId));

    // #264 — post-commit drain. A notifier throw here is caught INSIDE `drainRow`, stamped on the
    // outbox row, and never propagates out of `dispatchForZone` — the misreport inversion #264 exists
    // to close (a notifier failure used to surface as a zone dispatch error even though every schedule
    // had already committed).
    await drainRows(this.prisma, this.notifier, outboxIds, now);

    return {
      schedules,
      batches,
      tickets,
      ...(seSkips.length > 0 ? { seSkips } : {}),
      ...(orphansCleared > 0 ? { orphansCleared } : {}),
    };
  }

  /**
   * One SE's day plan, in one transaction (#262).
   *
   * Everything this touches belongs to this SE: their claimed recommendations, their schedule, their
   * batches, their tickets. The transaction's duration is therefore bounded by `daily_capacity` rather
   * than by the size of the zone, which is what takes the interactive-transaction budget off the
   * critical path.
   */
  private async dispatchForSe(
    zoneId: bigint,
    seId: string,
    opts: DispatchOptions,
    now: Date,
    outboxIds: bigint[],
  ): Promise<{ schedules: number; batches: number; tickets: number }> {
    const empty = { schedules: 0, batches: 0, tickets: 0 };
    return this.prisma.$transaction(async (tx) => {
      // #262 item 2 — the zone advisory lock is now taken per SE and **blocking**, not `try`. Its job
      // changed: run-vs-run exclusion is #259's zone claim, so what is left is exclusion against
      // closure and bulk-unassign, whose windows are milliseconds. A blocking wait is therefore the
      // right posture — but an unbounded one would turn a stuck holder into a stuck dispatch, so
      // `lock_timeout` bounds it and a timeout costs this SE only.
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${this.zoneLockTimeoutMs}ms'`);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${dispatchZoneLockKey(zoneId)}))`;

      // Claim this SE's rows. SKIP LOCKED is the point: a concurrent claimer's rows become invisible
      // rather than a P2002 nobody can recover from in place (a P2002 aborts its transaction, #265).
      // `FOR UPDATE OF r` names the recommendations alone — the joined ticket and plant rows are read
      // for their columns and must not be locked, or an unrelated ticket write would block on us.
      const claimed = await tx.$queryRaw<Array<{ recommendation_id: bigint; ticket_id: string; plant_id: bigint }>>`
        SELECT r."recommendation_id", r."ticket_id", t."plant_id"
          FROM "recommendations" r
          JOIN "tickets" t ON t."ticket_id" = r."ticket_id"
          JOIN "plants" p ON p."plant_id" = t."plant_id"
         WHERE r."status" = 'SUGGESTED' AND r."se_id" = ${seId}::uuid AND p."zone_id" = ${zoneId}
         ORDER BY r."processing_rank" ASC NULLS LAST, r."recommendation_id" ASC
           FOR UPDATE OF r SKIP LOCKED`;
      if (claimed.length === 0) return empty;

      // Idempotency guard (belt to the `batch_assignment_tickets_one_active_per_ticket` braces): a
      // ticket already sitting in a LIVE batch is never assigned a second time. #262 re-reads it per
      // SE and therefore *inside* the transaction that will act on it, which is what makes a re-invoke
      // after a partial dispatch see its own earlier progress — the zone-wide read could not.
      const alreadyAssigned = new Set(
        (
          await tx.batchAssignmentTicket.findMany({
            where: { ticketId: { in: claimed.map((r) => r.ticket_id) }, removedAt: null },
            select: { ticketId: true },
          })
        ).map((t) => t.ticketId),
      );
      const fresh = claimed.filter((r) => !alreadyAssigned.has(r.ticket_id));

      // plant_id → ticket_ids, insertion order = canonical processing order.
      const byPlant = new Map<bigint, string[]>();
      for (const r of fresh) {
        const list = byPlant.get(r.plant_id) ?? [];
        list.push(r.ticket_id);
        byPlant.set(r.plant_id, list);
      }

      let schedules = 0;
      let batches = 0;
      let tickets = 0;

      if (byPlant.size > 0) {
        // APPEND, don't collide: reuse the SE's existing live (se, zone, day) schedule — an earlier
        // dispatch run today, or a ZM_MANUAL plan — instead of creating a second one. New stops
        // continue after the schedule's current last stop; a fresh schedule is created only when the
        // SE has none. The unique index stays the final safety net.
        //
        // #153 — "live" must include OVERRIDDEN, and here the index canNOT be the safety net: it is
        // partial on `status = 'ACTIVE'`, so once a ZM override flipped the schedule this lookup
        // missed it, the create succeeded unopposed, and the SE ended the day with two day-plans.
        // Oldest-first so an SE carrying legacy duplicates keeps the plan they are already executing.
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
        // #283 — the tier this SE covered each plant in, resolved once per plant for the whole
        // transaction. The engine chose within a tier (#258 Q1) but the recommendation row it reads
        // here does not carry which one, so it is resolved rather than threaded down from the
        // recommender — one indexed lookup per stop, not per ticket.
        const coverageByPlant = await resolveCoverageForPlants(tx, seId, [...byPlant.keys()]);
        for (const [plantId, ticketIds] of this.orderPlantStops(byPlant)) {
          stopSequence++;
          // A fresh batch per run (stamped with run_id) even when the plant already has a stop from an
          // earlier run — keeps run-attribution clean and sidesteps mutating another run's batch.
          const batch = await tx.plantBatchAssignment.create({
            data: { scheduleId, plantId, seId, status: 'AUTO_ASSIGNED', stopSequence, runId: opts.runId ?? null },
          });
          batches++;

          let sortOrder = 0;
          for (const ticketId of ticketIds) {
            sortOrder++;
            await tx.batchAssignmentTicket.create({
              data: {
                batchId: batch.batchId,
                ticketId,
                sortOrder,
                // #283 — the run placed this, so `added_by` stays NULL by construction: the actor
                // column answers "which person did this", and here none did. `run_id` on the batch is
                // the engine's own handle, exactly as terminal closure leaves `removed_by` NULL.
                addSource: ADD_SOURCES.AUTO_DISPATCH,
                coverageTypeAtAssign: coverageByPlant.get(String(plantId)) ?? null,
                // The run's own clock, not the database's, for the same reason the manual paths use
                // the caller's: one operation's rows should share one instant.
                createdAt: now,
              },
            });
            // Committed work leaves the Shared Pool (Issue 12): the dispatched ticket is now a Formal
            // Assignment, not pickable secondary work (schema D6, LLD shared-pool partial index).
            await tx.ticket.update({
              where: { ticketId },
              // #146 — clear any spent deferral as the ticket is re-dispatched. The batch row's
              // `deferred_to_date` is the durable record of what the ZM did (scorecard AC#7).
              data: { assignmentState: 'FORMALLY_ASSIGNED', deferredUntil: null },
            });
            tickets++;
          }
        }

        // #264 — written INSIDE this SE's own transaction: the intent commits with the plan or not at
        // all. A rollback after this point (e.g. the P2002 guard elsewhere in this class never applies
        // here, but a future failure would) takes the outbox row with it — no ghost "plan is live".
        const outboxId = await queueDayPlanDispatched(tx, { seId, scheduleId, zoneId, stops: stopSequence, tickets });
        outboxIds.push(outboxId);
      }

      // Consume every row this SE CLAIMED (Issue 100), the guarded duplicates included — they are done
      // with, not to be re-evaluated. Scoped to the claimed ids rather than to the SE, so a row that
      // arrived after the claim is left for the next pass instead of being silently retired unread.
      await tx.recommendation.updateMany({
        where: { recommendationId: { in: claimed.map((r) => r.recommendation_id) } },
        data: { status: 'DISPATCHED' },
      });

      return { schedules, batches, tickets };
    });
  }

  /**
   * Which SEs have dispatchable work in this zone. Read outside any transaction, and deliberately only
   * the *identities* — the rows are claimed per SE inside their own transaction, so this list is a
   * work queue rather than a snapshot anything depends on.
   */
  private async sesWithSuggestions(zoneId: bigint): Promise<string[]> {
    const rows = await this.prisma.recommendation.findMany({
      where: { status: 'SUGGESTED', seId: { not: null }, ticket: { plant: { zoneId } } },
      select: { seId: true, processingRank: true },
      orderBy: { processingRank: 'asc' },
    });
    // First appearance wins, so SEs are dispatched in the order their best-ranked ticket implies —
    // the same canonical order the single zone transaction walked.
    return [...new Set(rows.map((r) => r.seId!))];
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
   * dispatch P2002 on `work_schedules_one_active_per_se_zone_day`.
   *
   * #153 note — deliberately NOT widened to the live set. It answers "which rows did the database
   * refuse to duplicate?", and that index is partial on `status = 'ACTIVE'`; naming overridden
   * schedules here would blame rows that cannot have caused the collision.
   */
  async conflictingScheduleSeIds(zoneId: bigint, dateFrom: Date): Promise<string[]> {
    const rows = await this.prisma.workSchedule.findMany({
      where: { zoneId, dateFrom, status: UNIQUE_ACTIVE_SCHEDULE_INDEX_STATUS },
      select: { seId: true },
    });
    return [...new Set(rows.map((r) => r.seId))];
  }

  /**
   * #126/#262 — clear this run's leftover SUGGESTED rows for the SEs whose transaction failed.
   *
   * Keyed by `(run_id, zone, se_id, status='SUGGESTED')`. The `se_id` scope is #262's correction to a
   * zone-wide delete: with per-SE claiming, a row this dispatch never saw is a row **somebody else has
   * locked**, and sweeping the zone would delete work out from under its claimant. A no-op when the
   * caller supplied no `runId` (nothing to key on safely — the recommender's finalized/null-run sweep
   * collects those on the next run).
   */
  private async clearFailedSeOrphans(runId: bigint | undefined, zoneId: bigint, seIds: string[]): Promise<number> {
    if (runId === undefined || seIds.length === 0) return 0;
    const { count } = await this.prisma.recommendation.deleteMany({
      where: { runId, status: 'SUGGESTED', seId: { in: seIds }, ticket: { plant: { zoneId } } },
    });
    return count;
  }
}
