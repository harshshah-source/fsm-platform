import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { isNotDeferredOn, notDeferredOn } from '../ticketing/deferral';
import { RETIRED_RECOMMENDATION_STATUS } from '../recommender/recommendation-status';
import {
  DAY_PLAN_NOTIFIER,
  type DayPlanNotifier,
  LoggingDayPlanNotifier,
} from './day-plan-notifier';
import { ADD_SOURCES } from './add-source';
import { committedDayLoad } from './committed-day-load';
import { resolveCoverageForPlants } from './coverage-at-assign';
import { drainRows, queueDayPlanDispatched } from './day-plan-notification-outbox';
import { ZONE_LOCK_TIMEOUT_MS, dispatchEngineerLockKey, dispatchZoneLockKey } from './dispatch-zone-lock';
import { uniqueViolationModel } from '../common/unique-violation';
import { type SeSkip, describeSeSkip } from './se-skip';
import { UNIQUE_ACTIVE_SCHEDULE_INDEX_STATUS, liveBatchFilter, liveScheduleFilter } from './schedule-status';

export interface DispatchOptions {
  /** Day Plan coverage start (Schedule Cadence: daily → dateFrom === dateTo). */
  dateFrom: Date;
  dateTo: Date;
  now?: Date;
  /** Dispatch-run ledger id (transparency feature) — stamped on created schedules, observe-only. */
  runId?: bigint;
  /**
   * #305 — say the run is still alive, once per SE.
   *
   * The reaper judges a run by the freshness of its beat (#261), and the beat used to be stamped only
   * per ZONE — so a run's silence was bounded by its slowest single zone, and a big zone exceeded the
   * threshold while healthy: its live run was marked ABORTED, its claim freed, and the #286 collector
   * could start a second dispatch of a zone whose first was still writing. Per-SE is the right
   * granularity because the per-SE transaction is already the unit this loop is bounded by.
   *
   * Called strictly BETWEEN transactions, never inside one — a beat must not extend or join a data
   * transaction (the issue's boundary), and a beat inside a transaction that later rolls back would
   * not have happened at all.
   */
  onProgress?: () => Promise<void>;
}

export type { SeSkip };

/**
 * #306 — why the engine may not place a claimed ticket, or `null` when it may.
 *
 * The order is the order an operator would want it named in: a closed ticket is a different problem
 * from a held one. `notDeferredOn` semantics exactly — **not** `deferredUntil === null` — so a ticket
 * dispatched ON its return day still passes and still has its spent deferral cleared, which is the
 * behaviour `:283` has always had and the one regression risk the issue calls out.
 */
function ineligibleReason(
  ticket: { status: string; assignment_state: string; deferred_until: Date | null },
  day: Date,
  alreadyAssigned: boolean,
): TicketSkip['reason'] | null {
  if (ticket.status !== 'OPEN') return 'NOT_OPEN';
  if (ticket.assignment_state !== 'UNASSIGNED' || alreadyAssigned) return 'ALREADY_ASSIGNED';
  if (!isNotDeferredOn(ticket.deferred_until, day)) return 'DEFERRED';
  return null;
}

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
  /**
   * #306 — tickets the engine declined to place, and why. Absent when it placed everything it claimed.
   *
   * A **counted** skip, never a silent override: holds win over the engine (#251's contract — a hold
   * is "a date the existing `notDeferredOn` predicate already respects" — and every manual door needs
   * confirm+reason to break one, #249). A run that quietly dispatched a held ticket and one that had
   * nothing held must not report the same thing.
   */
  ticketSkips?: TicketSkip[];
}

/** Why one ticket was claimed but not placed (#306). */
export interface TicketSkip {
  ticketId: string;
  reason: 'NOT_OPEN' | 'ALREADY_ASSIGNED' | 'DEFERRED' | 'CHANGED_DURING_DISPATCH' | 'CAPACITY_REACHED';
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
 *
 * **#366 — the Zone Warehouse pickup stop is NOT emitted here, and that is the decision.** The plan
 * that filed the slice expected this run to write a stop 0 (or a pickup flag on the schedule) when a
 * ticket it placed had a SHIPPED component request. It does not, because the pickup is not a fact
 * about the dispatch: a part shipped an hour after this run has to appear on the plan, and the
 * moment the SE confirms receipt the stop has to go. Anything stamped here would be wrong in both
 * directions by mid-morning. `warehouse-pickup.ts` derives it at read time for both day-plan reads;
 * this run is unchanged, and so are its `stops`/`tickets` notification counts below, which count the
 * plant stops that are the SE's actual work.
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
    /** #306 — tickets the engine claimed but declined to place, across every SE in this zone. */
    const ticketSkips: TicketSkip[] = [];
    let schedules = 0;
    let batches = 0;
    let tickets = 0;

    // Read OUTSIDE any transaction: only *which* SEs have work. The rows themselves are re-read and
    // claimed inside each SE's own transaction, so this list going stale is harmless — an SE whose
    // work vanished simply claims nothing.
    const seIds = await this.sesWithSuggestions(zoneId);
    if (seIds.length === 0) return { schedules: 0, batches: 0, tickets: 0 };

    for (const seId of seIds) {
      // #307 — at most one retry, and only for the ticket collision.
      //
      // A manager assigning one ticket inside this SE's transaction window trips the
      // `batch_assignment_tickets` partial unique, and a P2002 aborts its interactive transaction
      // (#265) — so the SE lost their WHOLE plan and `clearFailedSeOrphans` retired every SUGGESTED
      // row they had, over one ticket somebody else took. Recovery meant a human noticing the zone
      // card and pressing Run again.
      //
      // Retrying works without any new coordination because the idempotency re-read inside
      // `dispatchForSe` runs in the NEW transaction: the collided ticket is now in `alreadyAssigned`,
      // folds out as a named `ALREADY_ASSIGNED` skip, and the rest of the plan dispatches. Blocking the
      // manual doors instead was rejected in the issue — it would make an operator wait on the engine,
      // which inverts #258's posture.
      for (let attempt = 0; ; attempt++) {
        try {
          const out = await this.dispatchForSe(zoneId, seId, opts, now, outboxIds);
          schedules += out.schedules;
          batches += out.batches;
          tickets += out.tickets;
          ticketSkips.push(...out.ticketSkips);
          break;
        } catch (e) {
          // Scoped to the discriminated ticket unique. A `WorkSchedule` conflict keeps today's
          // semantics (retrying it would collide identically), and a lock timeout or a generic
          // database error must never loop.
          if (attempt === 0 && uniqueViolationModel(e) === 'BatchAssignmentTicket') {
            this.logger.log(
              `dispatch for zone ${zoneId}, SE ${seId}: a ticket was assigned mid-transaction — ` +
                `retrying this SE once so the collision costs one ticket, not the plan`,
            );
            continue;
          }
          const skip = describeSeSkip(seId, e);
          seSkips.push(skip);
          this.logger.warn(`dispatch for zone ${zoneId}, SE ${seId} skipped — ${skip.reason}`);
          break;
        }
      }
      // #305 — outside the per-SE transaction, and after it either way: a skipped SE still took time,
      // so the run is just as alive and just as much in need of saying so.
      if (opts.onProgress) await opts.onProgress();
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
      ...(ticketSkips.length > 0 ? { ticketSkips } : {}),
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
  ): Promise<{ schedules: number; batches: number; tickets: number; ticketSkips: TicketSkip[] }> {
    // #306 — collected inside the transaction but reported whatever it commits: a skip is a fact about
    // work the run declined, and a rolled-back SE reports through `seSkips` instead.
    const ticketSkips: TicketSkip[] = [];
    const empty = { schedules: 0, batches: 0, tickets: 0, ticketSkips };
    return this.prisma.$transaction(async (tx) => {
      // #262 item 2 — the zone advisory lock is now taken per SE and **blocking**, not `try`. Its job
      // changed: run-vs-run exclusion is #259's zone claim, so what is left is exclusion against
      // closure and bulk-unassign, whose windows are milliseconds. A blocking wait is therefore the
      // right posture — but an unbounded one would turn a stuck holder into a stuck dispatch, so
      // `lock_timeout` bounds it and a timeout costs this SE only.
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${this.zoneLockTimeoutMs}ms'`);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${dispatchZoneLockKey(zoneId)}))`;
      // #304 — and the engineer, across zones. `daily_capacity` caps the whole day but zone claims
      // serialize per zone, so two runs in different zones could each fill the same floating SE to
      // capacity. Ordered after the zone lock in every transaction that takes both, and no transaction
      // ever asks for a zone lock while holding an engineer lock — so contention on one engineer is a
      // queue, never a cycle, and every other engineer in both zones proceeds in parallel.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${dispatchEngineerLockKey(seId)}))`;

      // Claim this SE's rows. SKIP LOCKED is the point: a concurrent claimer's rows become invisible
      // rather than a P2002 nobody can recover from in place (a P2002 aborts its transaction, #265).
      // `FOR UPDATE OF r` names the recommendations alone — the joined ticket and plant rows are read
      // for their columns and must not be locked, or an unrelated ticket write would block on us.
      // #306 — the ticket's liveness columns come back with the claim so an ineligible ticket can be
      // named rather than merely dropped. They are READ, not locked (`FOR UPDATE OF r` still names the
      // recommendations alone), so this is a pre-filter and not the guarantee — the guard on the ticket
      // write below is what actually holds when a hold lands after this read.
      const claimed = await tx.$queryRaw<
        Array<{
          recommendation_id: bigint;
          ticket_id: string;
          plant_id: bigint;
          status: string;
          assignment_state: string;
          deferred_until: Date | null;
        }>
      >`
        SELECT r."recommendation_id", r."ticket_id", t."plant_id",
               t."status", t."assignment_state", t."deferred_until"
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

      // #306 (RC-7) — the recommender wrote SUGGESTED minutes ago; a ZM has had that whole window to
      // place a hold, and the operators using the preview screen do it in exactly that window. Skip
      // here rather than at the claim's WHERE **on purpose**: an unclaimed row stays SUGGESTED for
      // ever (only `clearFailedSeOrphans` sweeps them, and only for SEs whose transaction threw), so
      // an excluded ticket would leave the poisoned-ledger residue #126 exists to prevent. Claimed and
      // skipped, the row is retired with its siblings at the end of this transaction.
      const eligible = claimed.filter((r) => {
        const reason = ineligibleReason(r, opts.dateFrom, alreadyAssigned.has(r.ticket_id));
        if (reason === null) return true;
        ticketSkips.push({ ticketId: r.ticket_id, reason });
        return false;
      });
      // #304 (RC-4) — commit-time capacity, read inside this transaction and therefore behind the
      // engineer lock above. The recommender seeds its counter from committed rows once per zone-run
      // and increments only its own wins, so its optimism is fine — but nothing enforced it at the one
      // place that can: the moment of commit. Two zone runs offering the same floating SE five stops
      // each used to commit ten.
      //
      // `committedDayLoad` is THE definition of "committed" (#269) and is reused, not respelled — the
      // number a manager reads beside `daily_capacity` has to be the number the engine enforces.
      // Counted BEFORE this transaction writes anything, so it cannot count its own rows.
      const engineer = await tx.engineerMaster.findUnique({
        where: { engineerId: seId },
        select: { dailyCapacity: true },
      });
      const capacity = engineer?.dailyCapacity ?? null;
      let fresh = eligible;
      if (capacity !== null) {
        const committed = (await committedDayLoad(tx, opts.dateFrom, { seIds: [seId] })).get(seId) ?? 0;
        const remaining = Math.max(0, capacity - committed);
        if (eligible.length > remaining) {
          // The claim is ordered by `processing_rank`, so the prefix that fits is the engine's own
          // priority order — the surplus dropped is the work it ranked last, not an arbitrary slice.
          for (const r of eligible.slice(remaining)) {
            ticketSkips.push({ ticketId: r.ticket_id, reason: 'CAPACITY_REACHED' });
          }
          fresh = eligible.slice(0, remaining);
        }
      }

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
        // #283 — the tier this SE covered each plant in, resolved once per plant for the whole
        // transaction. The engine chose within a tier (#258 Q1) but the recommendation row it reads
        // here does not carry which one, so it is resolved rather than threaded down from the
        // recommender — one indexed lookup per stop, not per ticket.
        const coverageByPlant = await resolveCoverageForPlants(tx, seId, [...byPlant.keys()]);

        // #334 — THE TICKET ROWS COME FIRST, before this transaction touches `work_schedules`.
        //
        // #306 established that the ticket write precedes the *batch* row; #327 then gave the manual
        // doors one acquisition order across all four tables, `tickets → work_schedules →
        // plant_batch_assignments → batch_assignment_tickets`, and named this run as the writer still
        // outside it: it took the schedule first and the tickets second. That inverted pair is a cycle
        // with any manual assign, which locks the ticket row and then reaches for the same SE's
        // schedule — the run holds the schedule and waits for the ticket, the assign holds the ticket
        // and waits on the schedule's partial unique. Narrow (it needs the SE's *first* schedule of the
        // day to be created by both at once) and mapped rather than fatal since #327 — but a mapped
        // deadlock is still an operator repeating a click, and on this side of it a whole day plan.
        //
        // **The run moved, not the manual doors** — the one decision #334 asks for, recorded here and
        // in `override.service.ts`'s order note. The doors' order is the one #327 measured and chose
        // for reasons that still hold (the ticket row is what every path contends on; realigning the
        // lane would unwind #265's `SKIP LOCKED` re-verify), so the file that must change is the one
        // that never stated an order at all. It also costs this run nothing: the schedule is only
        // needed once there is something to hang off it.
        //
        // Nothing else moves. The per-plant guard, its skip vocabulary, and the claim/capacity reads
        // above are untouched; only the point at which the schedule is resolved comes later.
        const placedByPlant: [bigint, string[]][] = [];
        for (const [plantId, ticketIds] of this.orderPlantStops(byPlant)) {
          // #306 (RC-7) — the ticket write is guarded.
          //
          // It used to be an unconditional update by primary key, after the batch row was already
          // inserted. Two consequences, both real: a hold placed after the claim read was erased
          // (`deferredUntil: null`, no predicate) leaving an audit trail showing a hold placed and
          // nothing overriding it, and a ticket CLOSED in the same window still landed on the day plan
          // until the 04:00 closure recycled it. Putting the guard in the WHERE lets the database pick
          // the winner; doing it before the batch row means a loser leaves no row behind to explain.
          //
          // `notDeferredOn(day)` and not `deferredUntil: null`: a ticket dispatched ON its return day
          // is legitimate and still has its spent deferral cleared, exactly as before.
          const placed: string[] = [];
          for (const ticketId of ticketIds) {
            const { count } = await tx.ticket.updateMany({
              where: {
                ticketId,
                status: 'OPEN',
                assignmentState: 'UNASSIGNED',
                ...notDeferredOn(opts.dateFrom),
              },
              // Committed work leaves the Shared Pool (Issue 12): the dispatched ticket is now a Formal
              // Assignment, not pickable secondary work (schema D6, LLD shared-pool partial index).
              // #146 — clear any spent deferral as the ticket is re-dispatched. The batch row's
              // `deferred_to_date` is the durable record of what the ZM did (scorecard AC#7).
              data: { assignmentState: 'FORMALLY_ASSIGNED', deferredUntil: null },
            });
            if (count === 0) {
              ticketSkips.push({ ticketId, reason: 'CHANGED_DURING_DISPATCH' });
              continue;
            }
            placed.push(ticketId);
          }
          // Every ticket for this plant lost its guard — no stop, and no empty batch to explain.
          if (placed.length === 0) continue;
          placedByPlant.push([plantId, placed]);
        }

        // APPEND, don't collide: reuse the SE's existing live (se, zone, day) schedule — an earlier
        // dispatch run today, or a ZM_MANUAL plan — instead of creating a second one. New stops
        // continue after the schedule's current last stop; a fresh schedule is created only when the
        // SE has none. The unique index stays the final safety net.
        //
        // #153 — "live" must include OVERRIDDEN, and here the index canNOT be the safety net: it is
        // partial on `status = 'ACTIVE'`, so once a ZM override flipped the schedule this lookup
        // missed it, the create succeeded unopposed, and the SE ended the day with two day-plans.
        // Oldest-first so an SE carrying legacy duplicates keeps the plan they are already executing.
        //
        // #334 — resolved on `byPlant`, deliberately NOT on `placedByPlant`. An SE whose every claimed
        // ticket lost its guard still ends the transaction with a schedule and a `schedules` of 1,
        // exactly as before the reorder: this slice changes when the row is taken, not whether it is.
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
        for (const [plantId, placed] of placedByPlant) {
          stopSequence++;
          // A fresh batch per run (stamped with run_id) even when the plant already has a stop from an
          // earlier run — keeps run-attribution clean and sidesteps mutating another run's batch.
          const batch = await tx.plantBatchAssignment.create({
            data: { scheduleId, plantId, seId, status: 'AUTO_ASSIGNED', stopSequence, runId: opts.runId ?? null },
          });
          batches++;

          let sortOrder = 0;
          for (const ticketId of placed) {
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
            tickets++;
          }
        }

        // #321 (CB-8) — both numbers on ONE basis, and the basis is the SE's whole plan.
        //
        // They used to be mixed: `stops` was the running `stopSequence`, which continues from the
        // plan's existing maximum on an append, while `tickets` counted only the rows this run wrote.
        // An SE with three stops receiving one more stop of two tickets was told `stops=4, tickets=2` —
        // a pair describing no state the plan had ever been in. The two are only ever read together
        // (`SpineDayPlanNotifier` puts both in one notification's metadata), so mixing them is not a
        // rounding difference, it is a sentence that is false either way you read it.
        //
        // **Cumulative, and the argument is not stylistic.** The notification's body is "Your Day Plan
        // is live. Tap to start.", and the tap opens the SE's day plan — so these counts are checkable
        // against the screen they send the SE to. An incremental pair would be internally consistent
        // and still contradicted by Home the moment the SE looked. They are therefore read back the way
        // `DayPlanQueryService` reads them, through the shared `liveBatchFilter`, rather than derived
        // from this transaction's own bookkeeping: a stop whose every ticket has been removed is not on
        // the plan (#179 slice 3) and must not be counted here either.
        //
        // On a fresh plan the two bases coincide, so nothing about a first dispatch changes.
        const planStops = await tx.plantBatchAssignment.count({
          where: { scheduleId, ...liveBatchFilter(), tickets: { some: { removedAt: null } } },
        });
        const planTickets = await tx.batchAssignmentTicket.count({
          where: { removedAt: null, batch: { scheduleId, ...liveBatchFilter() } },
        });

        // #264 — written INSIDE this SE's own transaction: the intent commits with the plan or not at
        // all. A rollback after this point (e.g. the P2002 guard elsewhere in this class never applies
        // here, but a future failure would) takes the outbox row with it — no ghost "plan is live".
        const outboxId = await queueDayPlanDispatched(tx, { seId, scheduleId, zoneId, stops: planStops, tickets: planTickets });
        outboxIds.push(outboxId);
      }

      // Consume every row this SE CLAIMED (Issue 100), the guarded duplicates included — they are done
      // with, not to be re-evaluated. Scoped to the claimed ids rather than to the SE, so a row that
      // arrived after the claim is left for the next pass instead of being silently retired unread.
      await tx.recommendation.updateMany({
        where: { recommendationId: { in: claimed.map((r) => r.recommendation_id) } },
        data: { status: 'DISPATCHED' },
      });

      return { schedules, batches, tickets, ticketSkips };
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
    // #286 — retired, not deleted, for the reason `clearFinalizedOrphans` gives: the trace cascades on
    // delete, and a per-SE transaction that rolled back is exactly the case where somebody later asks
    // what the engine had intended for that engineer.
    const { count } = await this.prisma.recommendation.updateMany({
      where: { runId, status: 'SUGGESTED', seId: { in: seIds }, ticket: { plant: { zoneId } } },
      data: { status: RETIRED_RECOMMENDATION_STATUS },
    });
    return count;
  }
}
