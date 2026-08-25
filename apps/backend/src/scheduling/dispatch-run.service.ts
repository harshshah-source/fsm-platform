import { istDate, istDayStartInstant } from '../common/ist-day';
import { PLANT_ELIGIBLE_FLOATING_SE_MV, isMvStale } from '../org/plant-eligible-floating-se.service';
import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { buildStampFields } from '../build-info/run-stamp';
import { Prisma } from '../generated/prisma/client';
import type { DispatchRunStatus, DispatchRunTrigger } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { RecommenderService, type RunSummary, type ZoneProjection } from '../recommender/recommender.service';
import { SE_ASSIGNMENT_THRESHOLD_KEY } from '../settings/assignment-threshold';
import { BatchAssignmentService, type DispatchSummary } from './batch-assignment.service';
import {
  DISPATCH_CRON_SETTING_KEY,
  type DispatchRecoveryPolicy,
  type DispatchRetryPolicy,
  bootstrapDispatchCron,
  readDispatchRecoveryPolicy,
  readDispatchRetryPolicy,
  staleDispatchRunFilter,
} from './dispatch-cron';

export interface DispatchRunError {
  zoneId: string;
  message: string;
}

/**
 * #250 — how far ahead of the real clock an injected `now` may sit before the real dispatch path
 * treats it as a *future day* and refuses. Purely a clock-skew allowance: hosts drift, and a run
 * legitimately fired seconds before IST midnight must not be rejected because the process clock is a
 * little ahead. It is not a window in which future-dating is permitted.
 */
const FUTURE_DAY_SKEW_MS = 15 * 60 * 1000;

/** #260 — the patient run's wait between attempts. Real timers: it is waiting on another process. */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** What a preview answers with: the projected plan per zone, and nothing persisted (#250). */
export interface DispatchPreview {
  /** The IST calendar day previewed, `YYYY-MM-DD`. */
  targetDate: string;
  zones: ZoneProjection[];
  /** Zones whose projection failed — contained exactly like a real run's, never fatal. */
  errors: DispatchRunError[];
}

/** Who/what started the run — CRON (default, system actor) or the manual HTTP trigger. */
export interface DispatchRunOptions {
  trigger?: DispatchRunTrigger;
  actorUserId?: string;
  actorRole?: string;
  /**
   * #179 slice 2 — narrows the run to a single zone (the bulk-unassign rebalance's "Run dispatch"
   * button, zone-scoped). Omitted → every active zone, exactly as before this option existed.
   */
  zoneId?: bigint;
  /**
   * #213 — an optional one-line "why" for a MANUAL run, persisted on the ledger row. Optional by
   * ruling, not by omission: the operator asked for it to stay unobtrusive, because an emergency run
   * with a reason is worth a lot to whoever reads the audit trail three weeks later.
   */
  reason?: string | null;
  /**
   * #260 — override the patience policy for this run. Only consulted for a CRON run; a MANUAL run is
   * never patient whatever this says, because an operator pressing a button wants an answer rather
   * than a queue. Present for tests and for a caller that knows better than the environment.
   */
  retry?: DispatchRetryPolicy;
}

/** A run currently holding a zone, as reported to whoever was refused (#213). */
export interface DispatchInFlight {
  zoneId: string;
  /** ISO instant the holding run started — the "started HH:MM" the operator is shown. */
  startedAt: string;
  trigger: DispatchRunTrigger;
  /** Who started it: the actor's role, or `SYSTEM` for the cron. */
  actor: string;
  /**
   * #259 — the `dispatch_runs.run_id` doing the holding. Added with the DB-backed claim: an operator
   * refused by a run they cannot see needs a handle to go and look at it, and the CONTENDED ledger row
   * stores the same id so the refusal is readable months later.
   */
  runId?: string;
}

/**
 * What a single requested zone got out of a run (#259). `DONE`/`ERROR` are the two terminal states of
 * a claim this run actually held; `CONTENDED` is a zone it asked for and was refused, which is a
 * per-zone outcome now rather than a reason to refuse the whole request.
 */
export type DispatchZoneOutcome = 'DONE' | 'ERROR' | 'CONTENDED';

/** One requested zone's outcome, in the order the zones were asked for. */
export interface DispatchZoneOutcomeRow {
  zoneId: string;
  outcome: DispatchZoneOutcome;
  /** Present only on `CONTENDED` — who held the zone, so the caller can say more than "busy". */
  holder?: DispatchInFlight;
}

/**
 * The result of asking for a dispatch run (#213). A discriminated union rather than a bare summary
 * because a refusal is a first-class answer here: the operator ruling requires a *clear* conflict —
 * not a queued run, not a silent no-op — so every caller has to acknowledge the possibility.
 */
export type DispatchRunOutcome =
  | { result: 'RAN'; summary: DispatchRunSummary }
  | { result: 'CONFLICT'; inFlight: DispatchInFlight[] };

export interface DispatchRunSummary {
  /** Active zones processed this run. Contended zones are not "processed" and are not counted here. */
  zones: number;
  /** WorkSchedules dispatched across all zones. */
  schedules: number;
  /** Tickets placed on a Day Plan across all zones. */
  tickets: number;
  /** Zones that failed — recorded, not fatal (the run continues). */
  errors: DispatchRunError[];
  /** dispatch_runs ledger id (string — bigint does not survive JSON serialization). */
  runId: string;
  /**
   * #259 — per-zone outcome for **every** requested zone, contended ones included. The run-level
   * `zones` count above deliberately excludes contended zones, so without this a caller could not tell
   * a three-zone run that dispatched three zones from a four-zone run that was refused one.
   */
  zoneOutcomes: DispatchZoneOutcomeRow[];
}

/**
 * The run-level figures a zone contributes, accumulated across the zone loop (#260).
 *
 * Extracted from `execute`'s local variables when the retry pass gave the loop a *second* caller: two
 * copies of ten `+=` lines would have drifted the moment a column was added, and the invariant these
 * columns exist to hold — a run's totals equal the sum of its zone cards — is exactly the kind that
 * drift breaks silently. One object, one place that folds a zone into it.
 */
interface RunTotals {
  batches: number;
  recommended: number;
  unassignable: number;
  /** #238 — tickets the SE-assignment threshold held back this run. */
  withheldBelowThreshold: number;
  /** #242 — `null` until some zone reports: "not measured" is not the same answer as "dropped none". */
  bucketlessDropped: number | null;
  /** #177 — `null` on the same terms as the line above. */
  componentBlockedWithheld: number | null;
  /** Zones that did not fully dispatch — a hard error OR a benign skip. Drives the run status. */
  zonesWithIssue: number;
}

/**
 * Every zone the caller asked for was already claimed by the time the inserts ran (#259).
 *
 * Thrown from **inside** the admission transaction on purpose. A `dispatch_run_zones` row cannot exist
 * without its parent `dispatch_runs` row, so recording the refusal would mean opening a run that never
 * ran — and #213's refusal semantics are that a run which never happened leaves no history. The pre-read
 * catches this case without ever opening the transaction; this covers the race where the last free zone
 * is taken between that read and the insert, and rolling the transaction back is what keeps "409 with
 * zero rows" true in both.
 */
/**
 * Stamped on a claim the reaper freed (#261). A distinct sentence from the one
 * {@link DispatchRunService.releaseStrandedClaims} writes, because the two are different events: that
 * one means the run ended and forgot a zone, this one means nobody ended the run at all.
 */
export const ABANDONED_CLAIM_ERROR = 'ABANDONED — the run holding this zone stopped reporting';

/** What one collector pass did (#286). Every zone it looked at is in exactly one of these buckets. */
export interface DispatchRecoveryOutcome {
  /** Re-dispatch runs actually made this pass. */
  attempted: number;
  /** Zones whose re-dispatch completed — they have their day back. */
  recovered: number;
  /** Zones whose attempt budget ran out this pass. Recorded, surfaced, and not retried again today. */
  exhausted: number;
  /** Zones the operating-day cutoff overtook before they could be recovered. */
  expired: number;
  /** Zones still held by a live run — left PENDING for the next pass, and NOT charged an attempt. */
  deferred: number;
}

class AllZonesHeldError extends Error {
  /**
   * The holders are carried on the error rather than re-read after the rollback, because by then the
   * winner of a tight race may already have finished and released the zone — leaving the loser with a
   * bare 409 naming nobody, which is the one thing #213 said a refusal must never be. Read inside the
   * transaction, the row the insert collided with is committed and therefore guaranteed visible.
   */
  constructor(readonly holders: DispatchInFlight[]) {
    super('every requested zone is already claimed');
    this.name = 'AllZonesHeldError';
  }
}

/**
 * Issue 113 — the daily Recommender → Day-Plan dispatch run. This is the middle of the funnel that no
 * issue owned: ingestion (#97) ages device state, ticket creation (#112) chains off the telemetry
 * tick, the field-loop sweeps (#108) run unattended — but scoring + dispatch had no caller, so created
 * tickets sat OPEN/UNASSIGNED forever. `runForActiveZones` loops every active zone (a zone with at
 * least one plant) and runs {@link RecommenderService.runForZone} then
 * {@link BatchAssignmentService.dispatchForZone} — the latter is transactional, recommendation-
 * consuming and per-zone advisory-locked (#100), so a re-run the same day is a safe no-op and this
 * loop can sit on a daily timer or a manual trigger.
 *
 * A zone's failure is contained: it is logged + recorded in {@link DispatchRunSummary.errors} and the
 * remaining zones still dispatch. The Schedule Cadence is daily, so the Day Plan covers a single date
 * (`dateFrom === dateTo === the run day`).
 *
 * Transparency ledger (observe-only — records the dispatch, never alters selection/scoring/ordering):
 * every invocation opens a `dispatch_runs` row RUNNING with a config snapshot captured AT RUN START
 * (weights, capacity map, eligibility_mode, scheduler flag/cron — so history shows the config that
 * applied), writes one `dispatch_run_zones` row per zone (totals, mode, unassignable reason buckets,
 * contained error), threads `runId` into the recommender (which writes the per-ticket decision
 * traces) and the dispatcher (which stamps `work_schedules.run_id`), then finalizes
 * SUCCESS/PARTIAL/FAILED. The run is audit-bracketed (DISPATCH_RUN_STARTED/FINISHED) — previously the
 * batch run was an unaudited system actor.
 */
@Injectable()
export class DispatchRunService {
  private readonly logger = new Logger(DispatchRunService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly recommender: RecommenderService,
    private readonly dispatch: BatchAssignmentService,
    // Defaulted so direct construction in tests need not pass it; Nest injects the provider.
    private readonly audit: AuditService = new AuditService(prisma),
  ) {}

  async runForActiveZones(now: Date = new Date(), opts: DispatchRunOptions = {}): Promise<DispatchRunOutcome> {
    const trigger: DispatchRunTrigger = opts.trigger ?? 'CRON';
    const actorId = opts.actorUserId ?? 'SYSTEM';
    const actorRole = opts.actorRole ?? 'SYSTEM';
    const day = istDate(now);
    // #250 — the real path builds `work_schedules` dated `day` and dispatches them to real SEs.
    // Nothing validated `now`, so a future date silently produced real future-dated day plans; the
    // only thing preventing it was that both live callers hardcode `new Date()` — an accident of the
    // call sites rather than a property of this function. Asking about tomorrow is now the preview's
    // job ({@link previewActiveZones}), so this refuses rather than quietly obliging.
    const latestAllowedDay = istDate(new Date(Date.now() + FUTURE_DAY_SKEW_MS));
    if (day.getTime() > latestAllowedDay.getTime()) {
      throw new Error(
        `Refusing to dispatch for a future day (${day.toISOString().slice(0, 10)} IST): a real run ` +
          `would create future-dated day plans. Use previewActiveZones() to project a future date.`,
      );
    }
    // Ascending, always — `activeZoneIds` orders by zone id and a scoped run is a single zone. Two
    // concurrent admissions therefore take their claims in the same order and cannot deadlock on each
    // other's speculative inserts.
    const zoneIds = opts.zoneId != null ? [opts.zoneId] : await this.activeZoneIds();

    // #261 — before asking who holds these zones, free the ones nobody is holding any more. Placed
    // here rather than inside `admit` for the reason `snapshot-run.service.ts` puts it before its own
    // guard: the pre-read in `admit` is what turns a held zone into a 409, and a reap that ran after it
    // would answer with a refusal it had itself just made obsolete.
    await this.reapStaleDispatchRuns(now);

    // #260 — the automatic run is patient; a manual one never is. Measured against the real clock, not
    // the injected `now`: waiting is wall-clock behaviour, and a test that fast-forwards the business
    // date must not thereby fast-forward a deadline.
    const retry = this.retryPolicyFor(trigger, opts);
    const patientUntil = retry === null ? 0 : Date.now() + retry.deadlineMs;

    // #259 — admission is the database's answer now, not a private field's. See {@link admit}.
    let admission = await this.admit(now, opts, { trigger, zoneIds });
    // Patience has to start HERE and not only after the run row exists. When every requested zone is
    // held, #259 opens no run at all — that is its "a run which never happened leaves no history" rule
    // and it is worth keeping — so there would be nothing for an in-run retry to retry under. Re-asking
    // for admission preserves the rule exactly: while everything is held, still nothing is written.
    while (admission.result === 'CONFLICT' && retry !== null && Date.now() + retry.intervalMs <= patientUntil) {
      await sleep(retry.intervalMs);
      // #261's reaper is what actually frees a *crashed* holder. Without this the patient run would
      // spend its whole deadline waiting behind a claim nobody is holding, then give up — which is the
      // risk #260's own issue names, and the reason #261 is its hard prerequisite.
      await this.reapStaleDispatchRuns(new Date());
      admission = await this.admit(now, opts, { trigger, zoneIds });
    }
    if (admission.result === 'CONFLICT') {
      if (retry !== null) {
        this.logger.warn(
          `dispatch run gave up after ${retry.deadlineMs} ms: every requested zone is still held ` +
            `by ${admission.inFlight.map((f) => `run ${f.runId} (zone ${f.zoneId})`).join(', ')}`,
        );
      }
      return { result: 'CONFLICT', inFlight: admission.inFlight };
    }

    try {
      return {
        result: 'RAN',
        summary: await this.execute(now, opts, {
          trigger,
          actorId,
          actorRole,
          day,
          runId: admission.runId,
          admitted: admission.admitted,
          contended: admission.contended,
          retry,
          patientUntil,
        }),
      };
    } finally {
      // A run that throws must not wedge its zones permanently refusing. #261 adds the reaper that
      // covers the case this cannot — a process that dies without unwinding at all.
      await this.releaseStrandedClaims(admission.runId);
    }
  }

  /**
   * How patient this run is allowed to be (#260), or `null` for none.
   *
   * The asymmetry is the ruling (#258 Q8.6), not an optimisation: **CRON is patient, MANUAL never is.**
   * Nobody is watching the 05:00 run, so a zone briefly held at 05:00:00 costing that zone its whole
   * day is a pure loss; an operator who pressed a button is watching, and turning their click into a
   * silent fifteen-minute queue would be worse than telling them the truth immediately.
   *
   * A `deadlineMs` of 0 means no patience at all — the issue's documented rollback switch.
   */
  private retryPolicyFor(trigger: DispatchRunTrigger, opts: DispatchRunOptions): DispatchRetryPolicy | null {
    if (trigger !== 'CRON') return null;
    const policy = opts.retry ?? readDispatchRetryPolicy();
    return policy.deadlineMs > 0 && policy.intervalMs > 0 ? policy : null;
  }

  /**
   * Take the per-zone claims for one run, and decide what the caller is told (#259).
   *
   * The shape here is forced by one fact: a `dispatch_run_zones` row cannot exist without its parent
   * `dispatch_runs` row. So there are exactly two answers and no third —
   *  - **every requested zone already held** -> 409, and **nothing written at all**, preserving #213's
   *    rule that a run which never happened leaves no history;
   *  - **at least one free** -> open the run, claim the free zones, and record the held ones as
   *    CONTENDED rows *on this run*, which is what makes a partial outcome legible afterwards.
   *
   * The claim itself is `INSERT ... ON CONFLICT DO NOTHING` against
   * `ux_dispatch_run_zones_one_running_per_zone`, deliberately **not** insert-and-catch: a P2002 aborts
   * its Postgres transaction, so catching one would leave nothing to continue with. `DO NOTHING`
   * answers with a row count instead, which lets the whole admission — run row, claims and refusals —
   * live in one transaction that can still roll back cleanly when the race takes the last free zone.
   */
  private async admit(
    now: Date,
    opts: DispatchRunOptions,
    ctx: { trigger: DispatchRunTrigger; zoneIds: bigint[] },
  ): Promise<
    | { result: 'CONFLICT'; inFlight: DispatchInFlight[] }
    | {
        result: 'ADMITTED';
        runId: bigint;
        admitted: bigint[];
        contended: Array<{ zoneId: bigint; holder: DispatchInFlight | null }>;
      }
  > {
    const { trigger, zoneIds } = ctx;

    // The cheap read, outside any transaction: in the ordinary all-held case it is the whole answer,
    // and taking it here means the common refusal never even opens a transaction to roll back.
    const preRead = await this.holdersFor(zoneIds);
    if (zoneIds.length > 0 && preRead.length === zoneIds.length) return { result: 'CONFLICT', inFlight: preRead };

    // Captured after the free-check and before the run row, so the snapshot is the config in effect at
    // the moment this run actually started rather than at the moment somebody asked.
    const configSnapshot = await this.captureConfigSnapshot(now);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const run = await tx.dispatchRun.create({
          data: {
            trigger,
            actorUserId: opts.actorUserId ?? null,
            actorRole: opts.actorRole ?? null,
            // Blank-as-absent: an empty box on the admin form means "no reason given", not "the reason
            // is the empty string" — a stored '' would render as a present-but-useless note.
            reason: opts.reason?.trim() || null,
            startedAt: now,
            // #261 — the opening beat. Without it the run is born silent and the reaper would judge its
            // whole first window on `started_at`, which is the very thing the beat replaces.
            heartbeatAt: now,
            configSnapshot,
            ...buildStampFields(),
          },
        });

        const admitted: bigint[] = [];
        const refused: bigint[] = [];
        for (const zoneId of zoneIds) {
          const claimed = await tx.$executeRaw`
            INSERT INTO "dispatch_run_zones" ("run_id", "zone_id", "status", "started_at")
            VALUES (${run.runId}, ${zoneId}, 'RUNNING'::"dispatch_zone_claim_status", ${now})
            ON CONFLICT DO NOTHING`;
          if (claimed === 1) admitted.push(zoneId);
          else refused.push(zoneId);
        }
        // One read serves both endings: it names the holders on a CONTENDED row, and it names them to
        // the caller when there is nothing left to admit.
        const holders = refused.length > 0 ? await this.claimantsOf(refused, run.runId, tx) : [];
        if (zoneIds.length > 0 && admitted.length === 0) throw new AllZonesHeldError(holders);

        const byZone = new Map(holders.map((h) => [h.zoneId, h]));
        const contended = refused.map((zoneId) => ({ zoneId, holder: byZone.get(zoneId.toString()) ?? null }));
        for (const { zoneId, holder } of contended) {
          await tx.dispatchRunZone.create({
            data: {
              runId: run.runId,
              zoneId,
              status: 'CONTENDED',
              contendedWithRunId: holder?.runId != null ? BigInt(holder.runId) : null,
              // A refusal is instantaneous: it starts and ends at admission. Leaving `finishedAt` null
              // would make a CONTENDED row look like a live claim to every reader that checks for one.
              startedAt: now,
              finishedAt: now,
            },
          });
        }
        return { result: 'ADMITTED' as const, runId: run.runId, admitted, contended };
      });
    } catch (e) {
      if (!(e instanceof AllZonesHeldError)) throw e;
      // Rolled back whole — no run row, no zone rows — and the caller is told who took the zones out
      // from under it, using the read taken while that was still provably true.
      return { result: 'CONFLICT', inFlight: e.holders };
    }
  }

  /**
   * The live claims, read from the ledger (#259). `zoneIds === null` means every zone — the in-flight
   * endpoint's question. Raw because the join to `dispatch_runs` is what carries the holder's identity,
   * and because the same query has to run inside the admission transaction against `tx`.
   */
  private async holdersFor(
    zoneIds: bigint[] | null,
    client: Pick<PrismaService, '$queryRaw'> = this.prisma,
  ): Promise<DispatchInFlight[]> {
    if (zoneIds !== null && zoneIds.length === 0) return [];
    const scope = zoneIds === null ? Prisma.sql`TRUE` : Prisma.sql`z."zone_id" IN (${Prisma.join(zoneIds)})`;
    return this.readClaims(client, Prisma.sql`
      SELECT z."zone_id", z."run_id", z."started_at", r."trigger", r."actor_role"
        FROM "dispatch_run_zones" z
        JOIN "dispatch_runs" r ON r."run_id" = z."run_id"
       WHERE z."status" = 'RUNNING'::"dispatch_zone_claim_status" AND ${scope}
       ORDER BY z."zone_id" ASC`);
  }

  /**
   * Which run took each of these zones — the question a caller whose claim insert just collided has,
   * and a **different** question from {@link holdersFor}'s "who holds it right now" (#259).
   *
   * The distinction is not pedantry, it is a race this spec found: the winner of a tight admission race
   * can finalize its claim to DONE before the loser gets to look, and a live-only read then answers
   * "nobody", leaving the loser with a 409 naming no one — the exact bare refusal #213 exists to
   * prevent. The latest claim row for the zone is stable under that race and is by construction the row
   * the insert collided with: no second claim could have been taken while the first was RUNNING.
   */
  private async claimantsOf(
    zoneIds: bigint[],
    excludeRunId: bigint,
    client: Pick<PrismaService, '$queryRaw'>,
  ): Promise<DispatchInFlight[]> {
    if (zoneIds.length === 0) return [];
    return this.readClaims(client, Prisma.sql`
      SELECT DISTINCT ON (z."zone_id")
             z."zone_id", z."run_id", z."started_at", r."trigger", r."actor_role"
        FROM "dispatch_run_zones" z
        JOIN "dispatch_runs" r ON r."run_id" = z."run_id"
       WHERE z."zone_id" IN (${Prisma.join(zoneIds)}) AND z."run_id" <> ${excludeRunId}
       ORDER BY z."zone_id" ASC, z."started_at" DESC, z."id" DESC`);
  }

  /** Shared shaping for the two claim reads — one place decides how a holder is described. */
  private async readClaims(client: Pick<PrismaService, '$queryRaw'>, sql: Prisma.Sql): Promise<DispatchInFlight[]> {
    const rows = await client.$queryRaw<
      Array<{ zone_id: bigint; run_id: bigint; started_at: Date; trigger: DispatchRunTrigger; actor_role: string | null }>
    >(sql);
    return rows.map((r) => ({
      zoneId: r.zone_id.toString(),
      startedAt: r.started_at.toISOString(),
      trigger: r.trigger,
      // The ledger stores a null `actor_role` for the cron; the operator-facing word for that is SYSTEM,
      // and it is the same word the run's audit bracket uses.
      actor: r.actor_role ?? 'SYSTEM',
      runId: r.run_id.toString(),
    }));
  }

  /**
   * Free the zones of runs whose process stopped existing (#261).
   *
   * This is the half {@link releaseStrandedClaims} cannot do. That runs in a `finally`, so it covers a
   * run that throws, is cancelled, or otherwise *unwinds*. A process that is killed unwinds nothing: it
   * leaves a RUNNING `dispatch_runs` row and RUNNING claims under it, and because #259 made the claim
   * durable those claims now refuse their zones to every future run permanently. Nothing else in the
   * system will ever close them.
   *
   * Two writes, deliberately in this order: the run first, then its claims. If the process running the
   * reaper dies between them the claims are still RUNNING under an ABORTED run, which the next reap
   * pass finds and finishes — whereas freeing the claims first would leave a RUNNING run holding
   * nothing, which reads as a live run doing no work and is a state no later pass would correct.
   *
   * Both writes carry the status predicate for #265's reason: a write by primary key silently
   * resurrects a state somebody else already closed. Here that somebody is a run that woke up and
   * finalized itself in the gap, and overwriting its result would be the zombie-resurrect defect in
   * reverse.
   */
  async reapStaleDispatchRuns(now: Date = new Date()): Promise<{ runs: number; claims: number }> {
    const stale = await this.prisma.dispatchRun.findMany({
      where: { status: 'RUNNING', ...staleDispatchRunFilter(now) },
      select: { runId: true },
    });
    const runIds = stale.map((r) => r.runId);

    const { count: runs } =
      runIds.length === 0
        ? { count: 0 }
        : await this.prisma.dispatchRun.updateMany({
            where: { runId: { in: runIds }, status: 'RUNNING' },
            data: { status: 'ABORTED', finishedAt: now },
          });

    // Read by *predicate*, not by the run ids above. The two writes are deliberately not one
    // transaction (see the doc comment), so a reaper that died between them left RUNNING claims under
    // an already-ABORTED run — which the run-id list, sourced from RUNNING runs, could never find
    // again. `run.status <> RUNNING` is the whole population of stranded claims, this pass's and any
    // earlier pass's, and finding it is what makes the comment's "the next reap pass finishes it"
    // true rather than aspirational.
    const orphans = await this.prisma.dispatchRunZone.findMany({
      where: { status: 'RUNNING', run: { status: { not: 'RUNNING' } } },
      select: { id: true, zoneId: true, runId: true },
    });
    if (orphans.length === 0) {
      if (runs > 0) this.logger.warn(`reaped ${runs} abandoned dispatch run(s) [${runIds.join(', ')}]`);
      return { runs, claims: 0 };
    }

    // #286 — marked BEFORE the claims are freed, and not after. If this process dies in the gap the
    // claim is still RUNNING under a terminal run, so the next pass finds it here again and re-marks;
    // marking afterwards would lose the zone's day to the very crash the reaper exists to survive.
    // The reaper still does not dispatch (#261's rule): it leaves a row saying a day is owed.
    await this.markZonesForRecovery(orphans, now);

    const { count: claims } = await this.prisma.dispatchRunZone.updateMany({
      where: { id: { in: orphans.map((o) => o.id) }, status: 'RUNNING' },
      data: { status: 'ERROR', error: ABANDONED_CLAIM_ERROR, finishedAt: now },
    });
    this.logger.warn(
      `reaped ${runs} abandoned dispatch run(s) [${runIds.join(', ')}], freeing ${claims} zone claim(s)`,
    );
    return { runs, claims };
  }

  /**
   * #286 — record that these zones are owed a re-dispatch today, without dispatching anything.
   *
   * Upserted per (zone, operating day), so a zone that crashes three times before noon draws from ONE
   * attempt budget. Two states are deliberately left alone rather than re-armed:
   *  - **EXHAUSTED** — the budget for this zone today is spent. Re-arming on a fresh crash would make
   *    "bounded" a property of each incident instead of the day, and a zone that crashes every run
   *    would loop forever, which is exactly AC5's failure mode.
   *  - **EXPIRED** — the field day is over. Re-dispatching it helps nobody and would put work on a
   *    plan no engineer will read.
   *
   * RECOVERED *is* re-armed: the zone crashed again after being put right, which is a new day owed,
   * and the preserved `attempts` is what keeps it bounded.
   */
  private async markZonesForRecovery(orphans: Array<{ zoneId: bigint; runId: bigint }>, now: Date): Promise<void> {
    const businessDate = istDate(now);
    // One mark per zone even when a zone lost several claims; the run named is whichever of them the
    // map keeps, and any of them is a true answer to "which dead run left this zone owed a day".
    const runByZone = new Map(orphans.map((o) => [o.zoneId, o.runId]));
    for (const zoneId of runByZone.keys()) {
      try {
        await this.prisma.dispatchZoneRecovery.upsert({
          where: { zoneId_businessDate: { zoneId, businessDate } },
          create: {
            zoneId,
            businessDate,
            state: 'PENDING',
            attempts: 0,
            markedAt: now,
            markedByRunId: runByZone.get(zoneId) ?? null,
          },
          update: {},
        });
        // Separate from the upsert on purpose: `update: {}` above cannot express "only if the row is
        // still re-armable", and a blanket update would resurrect an EXHAUSTED or EXPIRED zone.
        await this.prisma.dispatchZoneRecovery.updateMany({
          where: { zoneId, businessDate, state: { in: ['PENDING', 'RECOVERED'] } },
          data: { state: 'PENDING', markedAt: now, markedByRunId: runByZone.get(zoneId) ?? null, resolvedAt: null },
        });
      } catch (e) {
        // A zone whose mark cannot be written must not stop the claims from being freed — a wedged
        // zone is strictly worse than an unrecovered one.
        this.logger.error(
          `failed to mark zone ${zoneId} for same-day re-dispatch: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  /**
   * #286 — re-dispatch the zones the reaper marked, the same day, bounded.
   *
   * **It adds no scheduling of its own.** Every zone goes through `runForActiveZones` exactly as the
   * 05:00 tick and the manual button do: same tick claim upstream, same per-zone claim row, same per-SE
   * transactions, same idempotency guards (#258 G1-G8). That is why AC3 holds without a line of code
   * here — work the dead run already committed is already committed, and the recommendation-consuming
   * dispatch simply finds nothing left to place for it.
   *
   * Two bounds, and they bind different failures:
   *  - **the attempt budget** stops a zone that keeps failing. Spent only on a run that actually
   *    happened; a *refusal* (some live run holds the zone) leaves the mark PENDING and unbilled,
   *    because being busy is not being broken and charging for it would exhaust a healthy zone.
   *  - **the operating-day cutoff** stops the refusal case from looping forever, and stops a recovery
   *    landing on a field day that is over.
   *
   * Zones are walked in ascending id, the order every other admission uses, so a collector and a cron
   * tick take their claims in the same order and cannot deadlock on each other.
   *
   * Never patient (`deadlineMs: 0`). #260's patience is for a run that has one chance today; this one
   * gets another chance in five minutes, and a fifteen-minute wait inside a five-minute tick would
   * simply hold the collector's own window shut.
   */
  async recoverMarkedZones(
    now: Date = new Date(),
    opts: { policy?: DispatchRecoveryPolicy } = {},
  ): Promise<DispatchRecoveryOutcome> {
    const policy = opts.policy ?? readDispatchRecoveryPolicy();
    const businessDate = istDate(now);
    const out: DispatchRecoveryOutcome = { attempted: 0, recovered: 0, exhausted: 0, expired: 0, deferred: 0 };

    const marks = await this.prisma.dispatchZoneRecovery.findMany({
      where: { businessDate, state: 'PENDING' },
      orderBy: { zoneId: 'asc' },
    });
    if (marks.length === 0) return out;

    // Hours into the IST operating day. Derived from the day's own start instant rather than from
    // `now.getHours()`, which is the host's timezone and would move the cutoff with the deploy.
    const istHour = (now.getTime() - istDayStartInstant(now).getTime()) / 3_600_000;
    if (istHour >= policy.cutoffHourIst) {
      const { count } = await this.prisma.dispatchZoneRecovery.updateMany({
        where: { id: { in: marks.map((m) => m.id) }, state: 'PENDING' },
        data: {
          state: 'EXPIRED',
          resolvedAt: now,
          lastError: `the operating-day cutoff (${policy.cutoffHourIst}:00 IST) passed before this zone was re-dispatched`,
        },
      });
      out.expired = count;
      if (count > 0) this.logger.warn(`same-day recovery: ${count} zone(s) expired at the operating-day cutoff`);
      return out;
    }

    for (const mark of marks) {
      if (mark.attempts >= policy.maxAttempts) {
        await this.retireMark(mark.id, mark.attempts, {
          state: 'EXHAUSTED',
          now,
          attempts: mark.attempts,
          lastError:
            mark.lastError ??
            `same-day re-dispatch gave up after ${mark.attempts} attempt(s) — the configured budget is ${policy.maxAttempts}`,
        });
        out.exhausted += 1;
        continue;
      }

      let failure: string | null = null;
      let recovered = false;
      try {
        const outcome = await this.runForActiveZones(now, {
          trigger: 'CRON',
          zoneId: mark.zoneId,
          retry: { intervalMs: 0, deadlineMs: 0 },
        });
        if (outcome.result === 'CONFLICT') {
          // Somebody live holds it. Not this zone's fault and not an attempt — try again next pass.
          out.deferred += 1;
          continue;
        }
        const zone = outcome.summary.zoneOutcomes.find((z) => z.zoneId === mark.zoneId.toString());
        if (zone?.outcome === 'CONTENDED') {
          out.deferred += 1;
          continue;
        }
        recovered = zone?.outcome === 'DONE';
        if (!recovered) {
          failure =
            outcome.summary.errors.find((e) => e.zoneId === mark.zoneId.toString())?.message ??
            'the re-dispatch run did not complete this zone';
        }
      } catch (e) {
        // Contained exactly like a zone failure inside a run: a zone that cannot be recovered must not
        // stop the collector from recovering the others.
        failure = e instanceof Error ? e.message : String(e);
      }

      out.attempted += 1;
      const attempts = mark.attempts + 1;
      if (recovered) {
        await this.retireMark(mark.id, mark.attempts, { state: 'RECOVERED', now, attempts, lastError: null });
        out.recovered += 1;
        this.logger.log(`same-day recovery: zone ${mark.zoneId} re-dispatched (attempt ${attempts})`);
        continue;
      }

      if (attempts >= policy.maxAttempts) {
        await this.retireMark(mark.id, mark.attempts, { state: 'EXHAUSTED', now, attempts, lastError: failure });
        out.exhausted += 1;
        this.logger.error(
          `same-day recovery EXHAUSTED for zone ${mark.zoneId} after ${attempts} attempt(s): ${failure}`,
        );
      } else {
        await this.prisma.dispatchZoneRecovery.updateMany({
          where: { id: mark.id, state: 'PENDING', attempts: mark.attempts },
          data: { attempts, lastAttemptAt: now, lastError: failure },
        });
        this.logger.warn(`same-day recovery attempt ${attempts} failed for zone ${mark.zoneId}: ${failure}`);
      }
    }
    return out;
  }

  /**
   * Close a recovery mark (#286). `state = 'PENDING'` and the attempt count this pass read are both in
   * the predicate for #265's reason: a write by primary key silently overwrites a decision somebody
   * else already made — here, a second collector that got the zone first.
   */
  private async retireMark(
    id: bigint,
    seenAttempts: number,
    ctx: { state: 'RECOVERED' | 'EXHAUSTED'; now: Date; lastError: string | null; attempts: number },
  ): Promise<void> {
    await this.prisma.dispatchZoneRecovery.updateMany({
      where: { id, state: 'PENDING', attempts: seenAttempts },
      data: {
        state: ctx.state,
        attempts: ctx.attempts,
        // Only stamped when this pass actually ran something — a mark retired because its budget was
        // already spent must not claim an attempt time it never spent.
        ...(ctx.attempts > seenAttempts ? { lastAttemptAt: ctx.now } : {}),
        resolvedAt: ctx.now,
        lastError: ctx.lastError,
      },
    });
  }

  /**
   * Say this run is still alive (#261) — stamped after every zone, so a run's silence is bounded by its
   * slowest single zone rather than by its total length. A single-column write outside any transaction.
   *
   * Scoped to `status = 'RUNNING'`: a run the reaper already gave up on must not beat its way back into
   * looking alive, and a terminal run with a fresh beat would mislead every human who read it.
   */
  private async touchHeartbeat(runId: bigint, now: Date = new Date()): Promise<void> {
    await this.prisma.dispatchRun.updateMany({
      where: { runId, status: 'RUNNING' },
      data: { heartbeatAt: now },
    });
  }

  /**
   * Finalize any claim this run is still holding, so one unwound run does not refuse its zones forever.
   *
   * Reached in a `finally`, which means it also runs after a clean run — where it matches nothing,
   * because every admitted zone was finalized as it completed. It cannot clobber a real result for the
   * same reason: `status = 'RUNNING'` is only true of a claim nobody closed.
   */
  private async releaseStrandedClaims(runId: bigint): Promise<void> {
    try {
      await this.prisma.dispatchRunZone.updateMany({
        where: { runId, status: 'RUNNING' },
        data: { status: 'ERROR', error: 'dispatch run ended without finalizing this zone', finishedAt: new Date() },
      });
    } catch (e) {
      // Never mask the error that is already on its way out of the `finally`.
      this.logger.error(
        `failed to release stranded claims for run ${runId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * #250 — project what a run would do, writing nothing. The non-mutating twin of
   * {@link runForActiveZones}, and deliberately *not* a second scheduling implementation: it drives
   * the same `RecommenderService.runForZone`, only with the writes suppressed (Decision 1/18).
   *
   * Three things it pointedly does not do, and each is the reason an operator can open the page
   * during a live dispatch without consequence:
   *  - **no in-flight slot** — it never touches {@link inFlight}, so it can neither be refused by a
   *    running dispatch nor refuse one;
   *  - **no advisory lock** — `BatchAssignmentService.dispatchForZone` is never reached, so the
   *    per-zone lock a real run holds is never contended for;
   *  - **no `dispatch_runs` row** — the ledger records runs that happened; a preview in it would
   *    corrupt every run-history read, and the trigger enum has no honest value for one.
   *
   * A zone that throws is contained exactly as in a real run: recorded in `errors`, the rest continue.
   */
  async previewActiveZones(
    targetDate: Date,
    opts: { zoneId?: bigint; now?: Date } = {},
  ): Promise<DispatchPreview> {
    const now = opts.now ?? new Date();
    const zoneIds = opts.zoneId != null ? [opts.zoneId] : await this.activeZoneIds();
    const zones: ZoneProjection[] = [];
    const errors: DispatchRunError[] = [];

    for (const zoneId of zoneIds) {
      try {
        const summary = await this.recommender.runForZone(zoneId, { now, dryRun: true, targetDate });
        // `projection` is present by construction on a dry run; the guard keeps the type honest
        // rather than asserting non-null.
        if (summary.projection) zones.push(summary.projection);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.logger.warn(`preview failed for zone ${zoneId}: ${message}`);
        errors.push({ zoneId: zoneId.toString(), message });
      }
    }

    return { targetDate: istDate(targetDate).toISOString().slice(0, 10), zones, errors };
  }

  /**
   * Every zone currently held by a run, for the admin's pre-emptive disabled state (#213 AC-9).
   *
   * #259 — read from the claim rows rather than from process memory, so the disabled state is truthful
   * about runs this instance did not start and about runs that were in flight when it last restarted.
   */
  inFlightZones(): Promise<DispatchInFlight[]> {
    return this.holdersFor(null);
  }

  /**
   * The run itself, once {@link admit} has opened the ledger row and claimed the zones it could get.
   *
   * It walks **admitted** zones only: a contended zone already has its terminal CONTENDED row and there
   * is nothing to dispatch for it. It appears in `zoneOutcomes` and in the run's status, never in the
   * per-zone processing.
   */
  private async execute(
    now: Date,
    opts: DispatchRunOptions,
    ctx: {
      trigger: DispatchRunTrigger;
      actorId: string;
      actorRole: string;
      day: Date;
      runId: bigint;
      admitted: bigint[];
      contended: Array<{ zoneId: bigint; holder: DispatchInFlight | null }>;
      /** #260 — null for a manual run, which never waits. */
      retry: DispatchRetryPolicy | null;
      /** Real-clock instant the run stops asking. Meaningless when `retry` is null. */
      patientUntil: number;
    },
  ): Promise<DispatchRunSummary> {
    const { trigger, actorId, actorRole, day, runId, admitted, contended, retry, patientUntil } = ctx;

    await this.audit.record({
      actorId,
      actorRole,
      action: 'DISPATCH_RUN_STARTED',
      entityType: 'dispatch_run',
      entityId: runId.toString(),
      metadata: { trigger, zonesClaimed: admitted.length, zonesContended: contended.length },
    });

    // #287 — say it out loud when the floating-candidate pool is out of date. Non-blocking by design:
    // the codebase's posture toward a degraded input is to proceed and be honest about it, not to
    // refuse the day's dispatch. What changes is that the staleness is no longer silent — it is in
    // this log line and frozen into the run's own `config_snapshot` for whoever reads it later.
    await this.warnIfEligibilityStale(runId, day);

    const zoneOutcomes: DispatchZoneOutcomeRow[] = [];
    const summary: DispatchRunSummary = {
      zones: 0,
      schedules: 0,
      tickets: 0,
      errors: [],
      runId: runId.toString(),
      zoneOutcomes,
    };
    const totals: RunTotals = {
      batches: 0,
      recommended: 0,
      unassignable: 0,
      withheldBelowThreshold: 0,
      bucketlessDropped: null,
      componentBlockedWithheld: null,
      zonesWithIssue: 0,
    };

    for (const zoneId of admitted) {
      await this.processZone(zoneId, { now, day, runId }, summary, totals);
    }

    // Whatever is still held once the run is done asking. For a MANUAL run that is every contended
    // zone, because a manual run never asks twice.
    const stillContended =
      retry === null || contended.length === 0
        ? contended
        : await this.waitOutContention(contended, { now, day, runId }, retry, patientUntil, summary, totals);

    for (const c of stillContended) {
      zoneOutcomes.push({
        zoneId: c.zoneId.toString(),
        outcome: 'CONTENDED' as const,
        ...(c.holder ? { holder: c.holder } : {}),
      });
    }

    // #259 — a contended zone is neither a success nor a failure of this run: the work simply was not
    // this run's to do. It cannot be SUCCESS (the request was not fully served) and it cannot be FAILED
    // (nothing failed), which is exactly what PARTIAL already means on this ledger.
    // #260 — measured against the zones still held when the run finished, not against the zones that
    // were held at admission. A zone the retry waited out and then dispatched is a plain success; a run
    // that recovered every contended zone is SUCCESS, and saying PARTIAL would report a collision the
    // system absorbed as an outcome the operator has to interpret.
    const processed = summary.zoneOutcomes.length - stillContended.length;
    const status: DispatchRunStatus =
      stillContended.length === 0 && totals.zonesWithIssue === 0
        ? 'SUCCESS'
        : stillContended.length === 0 && processed > 0 && summary.errors.length >= processed
          ? 'FAILED'
          : 'PARTIAL';
    // #261 — conditional on the run still being RUNNING. The reaper presumes a silent run is dead and
    // is usually right; when it is wrong, the run wakes up here. An unconditional update would overwrite
    // ABORTED with SUCCESS after the zones had already been handed to somebody else — a ledger asserting
    // two runs dispatched the same zone, which is worse than either state on its own.
    const { count: finalized } = await this.prisma.dispatchRun.updateMany({
      where: { runId, status: 'RUNNING' },
      data: {
        finishedAt: new Date(),
        status,
        zones: summary.zones,
        schedules: summary.schedules,
        batches: totals.batches,
        ticketsDispatched: summary.tickets,
        recommended: totals.recommended,
        unassignable: totals.unassignable,
        withheldBelowThreshold: totals.withheldBelowThreshold,
        bucketlessDropped: totals.bucketlessDropped,
        componentBlockedWithheld: totals.componentBlockedWithheld,
      },
    });
    if (finalized === 0) {
      this.logger.warn(`dispatch run ${runId} finished after being reaped — ${status} not recorded`);
    }
    await this.audit.record({
      actorId,
      actorRole,
      action: 'DISPATCH_RUN_FINISHED',
      entityType: 'dispatch_run',
      entityId: runId.toString(),
      metadata: {
        status,
        zones: summary.zones,
        zonesContended: stillContended.length,
        schedules: summary.schedules,
        batches: totals.batches,
        ticketsDispatched: summary.tickets,
        recommended: totals.recommended,
        unassignable: totals.unassignable,
        withheldBelowThreshold: totals.withheldBelowThreshold,
        bucketlessDropped: totals.bucketlessDropped,
        componentBlockedWithheld: totals.componentBlockedWithheld,
        errorCount: summary.errors.length,
      },
    });

    this.logger.log(
      `dispatch run: ${summary.zones} zones, ${summary.schedules} schedules, ${summary.tickets} tickets, ` +
        `${summary.errors.length} errors, ${stillContended.length} contended`,
    );
    return summary;
  }

  /**
   * Keep asking for the zones this run was refused, until it gets them or runs out of time (#260).
   *
   * A dispatch collision is usually seconds long — a zone-scoped rebalance that happens to overlap
   * 05:00:00. Before this, that zone's daily dispatch was simply lost until tomorrow, which is a
   * disproportionate price for a transient lock. Every zone recovered here dispatches under the SAME
   * run row, so one morning's work stays one ledger entry.
   *
   * Bounded by construction: it sleeps only when the sleep would finish before the deadline, so the
   * loop cannot overrun `patientUntil` and therefore cannot still be running at the next day's tick.
   * Zones still held when time runs out keep their CONTENDED row — visible, never silent (G7).
   */
  private async waitOutContention(
    contended: Array<{ zoneId: bigint; holder: DispatchInFlight | null }>,
    ctx: { now: Date; day: Date; runId: bigint },
    retry: DispatchRetryPolicy,
    patientUntil: number,
    summary: DispatchRunSummary,
    totals: RunTotals,
  ): Promise<Array<{ zoneId: bigint; holder: DispatchInFlight | null }>> {
    let pending = contended;
    while (pending.length > 0 && Date.now() + retry.intervalMs <= patientUntil) {
      await sleep(retry.intervalMs);
      // Same reason as the admission loop: a crashed holder is freed by the reaper, not by waiting.
      await this.reapStaleDispatchRuns(new Date());
      // The run is alive and working the whole time it waits, and the reaper must be told so — a
      // patient run that stopped beating would reap itself.
      await this.touchHeartbeat(ctx.runId);

      const stillHeld: typeof pending = [];
      for (const c of pending) {
        if (await this.promoteContendedClaim(ctx.runId, c.zoneId)) {
          await this.processZone(c.zoneId, ctx, summary, totals);
        } else {
          stillHeld.push(c);
        }
      }
      pending = stillHeld;
    }
    if (pending.length > 0) {
      this.logger.warn(
        `dispatch run ${ctx.runId} gave up waiting after ${retry.deadlineMs} ms: zone(s) ` +
          `${pending.map((c) => c.zoneId).join(', ')} still held, left CONTENDED on the ledger`,
      );
    }
    return pending;
  }

  /**
   * Turn this run's CONTENDED row for a zone back into a live claim, if the zone is free (#260).
   *
   * An UPDATE rather than #259's INSERT, because the row already exists: `@@unique([runId, zoneId])`
   * means a run gets exactly one row per zone, so a late admission has to promote the refusal in place.
   * That is also the better record — the zone's whole story stays on one row.
   *
   * `contended_with_run_id` is deliberately **not** cleared. This run genuinely was refused this zone,
   * and who by is the only surviving trace of the collision; every reader discriminates on `status`, so
   * carrying it forward onto a DONE row costs nothing and keeps the history.
   *
   * The `NOT EXISTS` is the ordinary path and the partial unique is the backstop for two runs promoting
   * the same zone in the same instant. A P2002 here is safe to catch, unlike #265's: this is a single
   * statement with no interactive transaction to abort.
   */
  private async promoteContendedClaim(runId: bigint, zoneId: bigint): Promise<boolean> {
    try {
      const promoted = await this.prisma.$executeRaw`
        UPDATE "dispatch_run_zones" z
           SET "status" = 'RUNNING'::"dispatch_zone_claim_status",
               "started_at" = ${new Date()},
               "finished_at" = NULL
         WHERE z."run_id" = ${runId}
           AND z."zone_id" = ${zoneId}
           AND z."status" = 'CONTENDED'::"dispatch_zone_claim_status"
           AND NOT EXISTS (
             SELECT 1 FROM "dispatch_run_zones" h
              WHERE h."zone_id" = z."zone_id"
                AND h."status" = 'RUNNING'::"dispatch_zone_claim_status")`;
      return promoted === 1;
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') return false;
      throw e;
    }
  }

  /**
   * Recommend + dispatch one zone this run holds, close its claim, and fold its figures into the run.
   *
   * Extracted from `execute`'s loop by #260, which gave that loop a second caller (the retry pass) and
   * therefore made an inline body a duplication waiting to happen. Behaviour is unchanged: a zone's
   * failure is contained here, recorded, and the run continues.
   *
   * Totals are accumulated from EXACTLY what the zone row records — successes and contained failures
   * alike — so a run's columns equal the sum of its per-zone cards by construction. `undefined ?? 0`
   * covers a zone whose dispatch threw (no `out`) or whose recommender threw (no `rec`).
   */
  private async processZone(
    zoneId: bigint,
    ctx: { now: Date; day: Date; runId: bigint },
    summary: DispatchRunSummary,
    totals: RunTotals,
  ): Promise<void> {
    const { now, day, runId } = ctx;
    let rec: RunSummary | undefined;
    let out: DispatchSummary | undefined;
    let error: string | null = null;
    try {
      rec = await this.recommender.runForZone(zoneId, { now, runId });
      out = await this.dispatch.dispatchForZone(zoneId, { dateFrom: day, dateTo: day, now, runId });
      summary.zones++;
      // #126 — a benign non-dispatch (residual schedule conflict / lock contention) is no longer
      // silent: its reason is stamped on the zone row's `error`. A dispatched zone → skipReason
      // undefined → null. Same-day new work now APPENDS to the SE's existing plan (no whole-zone drop).
      error = out.skipReason ?? null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      this.logger.error(`dispatch run failed for zone ${zoneId}: ${error}`);
      summary.errors.push({ zoneId: zoneId.toString(), message: error });
    }
    await this.finalizeZoneClaim(runId, zoneId, rec, out, error);
    // #261 — one beat per zone. A run over many zones is legitimately long, and this is what stops the
    // reaper mistaking length for death. It follows the finalize rather than preceding it so the beat
    // attests to work completed, not work merely started.
    await this.touchHeartbeat(runId);
    summary.zoneOutcomes.push({ zoneId: zoneId.toString(), outcome: error === null ? 'DONE' : 'ERROR' });
    summary.schedules += out?.schedules ?? 0;
    summary.tickets += out?.tickets ?? 0;
    totals.batches += out?.batches ?? 0;
    totals.recommended += rec?.recommended ?? 0;
    totals.unassignable += rec?.unassignable ?? 0;
    totals.withheldBelowThreshold += rec?.withheldBelowThreshold ?? 0;
    if (rec) totals.bucketlessDropped = (totals.bucketlessDropped ?? 0) + rec.bucketlessDropped;
    if (rec) totals.componentBlockedWithheld = (totals.componentBlockedWithheld ?? 0) + rec.componentBlockedWithheld;
    if (error !== null) totals.zonesWithIssue++;
  }

  /**
   * Close this run's claim on a zone — written for successes AND contained failures.
   *
   * #259 turned this from a create into an update: the row already exists, because it is the claim the
   * run took at admission. `started_at` therefore now means "when the zone was claimed" rather than
   * "when its processing began", which is the honest reading for a ledger whose row is what blocks
   * everyone else — the zone is genuinely unavailable from admission, not from its turn in the loop.
   */
  private async finalizeZoneClaim(
    runId: bigint,
    zoneId: bigint,
    rec: RunSummary | undefined,
    out: DispatchSummary | undefined,
    error: string | null,
  ): Promise<void> {
    // #261 — `updateMany` keyed on the claim still being RUNNING, not `update` by `runId_zoneId`. The
    // primary key is still there in the `where`, so this addresses exactly one row; what the status
    // predicate adds is that the row must still be this run's to close. A reaper freed it means the
    // zone is already somebody else's, and writing this run's totals over that would credit its work
    // to a claim it no longer holds. The same rule as #265's `liveScheduleFilter()`.
    const { count } = await this.prisma.dispatchRunZone.updateMany({
      where: { runId, zoneId, status: 'RUNNING' },
      data: {
        // Same discriminator the backfill used, and the same one `error` has always carried: a benign
        // skip (lock contention, a residual schedule conflict) stamps it too, and that is deliberate —
        // the zone did not dispatch, whatever the reason.
        status: error === null ? 'DONE' : 'ERROR',
        mode: rec?.mode ?? null,
        weightSetRef: rec?.weightSetRef ?? null,
        ticketsConsidered: rec?.ticketsConsidered ?? 0,
        recommended: rec?.recommended ?? 0,
        unassignable: rec?.unassignable ?? 0,
        // #238 — a zone whose recommender threw has no figure to report; 0/null is honest, not a claim
        // that nothing was withheld.
        withheldBelowThreshold: rec?.withheldBelowThreshold ?? 0,
        // #242 - `null` rather than 0 for a zone whose recommender threw: "no figure" and "dropped
        // none" are different answers, and this column exists because the second used to be assumed.
        bucketlessDropped: rec?.bucketlessDropped ?? null,
        // #177 — same distinction: a zone whose recommender threw withheld no *measured* figure, and
        // saying 0 would claim it looked and found nothing waiting on a part.
        componentBlockedWithheld: rec?.componentBlockedWithheld ?? null,
        assignmentThresholdHours: rec?.assignmentThresholdHours ?? null,
        ...(rec?.unassignableReasons
          ? { unassignableReasons: rec.unassignableReasons as unknown as Prisma.InputJsonValue }
          : {}),
        schedules: out?.schedules ?? 0,
        batches: out?.batches ?? 0,
        ticketsDispatched: out?.tickets ?? 0,
        // #262 — per-SE failures, kept apart from `error`. A zone that dispatched four of five SEs did
        // not fail; recording that as a zone error would put it in the run's Errors column and make a
        // contained, named, single-engineer problem read as a zone outage.
        ...(out?.seSkips?.length ? { seSkips: out.seSkips as unknown as Prisma.InputJsonValue } : {}),
        error,
        finishedAt: new Date(),
      },
    });
    if (count === 0) {
      this.logger.warn(`dispatch run ${runId}: zone ${zoneId} finalized after its claim was released`);
    }
  }

  /**
   * The config in effect AT RUN START, frozen onto the ledger row: active scoring weight sets, the
   * cluster-multiplier and eligibility_mode settings, the per-SE capacity map (the historical "18/25"
   * denominator — a later capacity edit must not rewrite past runs), the scheduler flag/cron, and
   * (Issue 157 AC-6) every ACTIVE, unexpired company tier override — so history shows which
   * overrides were live for THIS run, even once a later sweep expires or an admin cancels them.
   */
  private async captureConfigSnapshot(now: Date): Promise<Prisma.InputJsonValue> {
    const [rules, settings, engineers, tierOverrides, mvFreshness] = await Promise.all([
      this.prisma.priorityRuleConfig.findMany({ where: { active: true }, orderBy: { id: 'asc' } }),
      this.prisma.systemSetting.findMany({
        where: {
          key: {
            in: [
              'plant_cluster_multiplier',
              'eligibility_mode',
              // #238 — the gate that decided which tickets this run was even allowed to look at. A run
              // whose recommended count is low is un-interpretable without it: 40 recommended out of a
              // 900-ticket backlog is a catastrophe at 24 h and correct at 72 h, and the two runs are
              // otherwise identical on the ledger.
              SE_ASSIGNMENT_THRESHOLD_KEY,
              // Captured alongside it because the pair is only readable together (2026-07-22 audit,
              // #124: this key was documented as missing from the snapshot). It is what `is_inactive`
              // — and therefore every SLA bucket the run sorted on — meant at the time.
              'inactivity_threshold_hours',
              DISPATCH_CRON_SETTING_KEY,
            ],
          },
        },
      }),
      this.prisma.engineerMaster.findMany({ select: { engineerId: true, dailyCapacity: true, isActive: true } }),
      this.prisma.companyTierOverride.findMany({
        where: { status: 'ACTIVE', expiresAt: { gt: now } },
        orderBy: [{ companyId: 'asc' }, { zoneId: 'asc' }, { createdAt: 'desc' }],
        select: { id: true, companyId: true, zoneId: true, tier: true, expiresAt: true },
      }),
      // #287 — the freshness of the FLOATING candidate pool this run is about to select from. Every
      // other input here is config an operator set; this one is the state of a derived view whose
      // 04:30 rebuild fails silently, and without it the frozen record cannot answer "what was this
      // decided against". Optional by construction: an absent row, an unavailable delegate or a
      // failed read all degrade to "unknown", which `isMvStale` treats as stale — the safe direction.
      this.mvFreshnessRow(),
    ]);
    return {
      priorityRules: rules.map((r) => ({ weightSetRef: r.weightSetRef, component: r.component, weight: Number(r.weight) })),
      settings: Object.fromEntries(settings.map((s) => [s.key, s.value])) as Prisma.InputJsonValue,
      capacity: Object.fromEntries(
        engineers.map((e) => [e.engineerId, { dailyCapacity: e.dailyCapacity, isActive: e.isActive }]),
      ),
      scheduler: {
        businessSweepsEnabled: process.env.BUSINESS_SWEEPS_ENABLED === 'true',
        // #213 — the schedule this run was generated under, read from the settings registry that now
        // owns it (#124: a configurable time must appear in the run-start snapshot, or history cannot
        // say which schedule produced a run). Falls back to the bootstrap default only for a run that
        // somehow precedes the row being seeded.
        dispatchCron:
          (settings.find((s) => s.key === DISPATCH_CRON_SETTING_KEY)?.value as string | undefined) ??
          bootstrapDispatchCron(),
      },
      tierOverrides: tierOverrides.map((o) => ({
        id: o.id.toString(),
        companyId: o.companyId.toString(),
        zoneId: o.zoneId.toString(),
        tier: o.tier,
        expiresAt: o.expiresAt.toISOString(),
      })),
      // `stale` is computed here, at admission, rather than left to whoever reads the snapshot later:
      // staleness is relative to the operating day this run belongs to, and a reader next month has
      // no way to reconstruct which day that was without re-deriving it from `started_at`.
      eligibilityMv: {
        viewName: PLANT_ELIGIBLE_FLOATING_SE_MV,
        lastSuccessAt: mvFreshness?.lastSuccessAt?.toISOString() ?? null,
        lastAttemptAt: mvFreshness?.lastAttemptAt?.toISOString() ?? null,
        lastError: mvFreshness?.lastError ?? null,
        stale: isMvStale(
          {
            viewName: PLANT_ELIGIBLE_FLOATING_SE_MV,
            lastAttemptAt: mvFreshness?.lastAttemptAt?.toISOString() ?? null,
            lastSuccessAt: mvFreshness?.lastSuccessAt?.toISOString() ?? null,
            lastError: mvFreshness?.lastError ?? null,
          },
          istDate(now),
        ),
      },
    };
  }

  /**
   * Log a warning when the FLOATING eligibility view has not rebuilt for the operating day (#287).
   *
   * Reads defensively and never throws: a run must not fail because its freshness bookkeeping is
   * unavailable, and a missing row is already treated as stale by `isMvStale`, which is the safe
   * direction to degrade in.
   */
  private async warnIfEligibilityStale(runId: bigint, day: Date): Promise<void> {
    try {
      const row = await this.mvFreshnessRow();
      const stale = isMvStale(
        {
          viewName: PLANT_ELIGIBLE_FLOATING_SE_MV,
          lastAttemptAt: row?.lastAttemptAt?.toISOString() ?? null,
          lastSuccessAt: row?.lastSuccessAt?.toISOString() ?? null,
          lastError: row?.lastError ?? null,
        },
        day,
      );
      if (!stale) return;
      this.logger.warn(
        `run ${runId}: ${PLANT_ELIGIBLE_FLOATING_SE_MV} has not rebuilt for this operating day ` +
          `(last success ${row?.lastSuccessAt?.toISOString() ?? 'never'}` +
          `${row?.lastError ? `, last error: ${row.lastError}` : ''}) — ` +
          'floating candidates may come from out-of-date territory data. Proceeding.',
      );
    } catch {
      /* freshness bookkeeping must never be the thing that fails a dispatch run */
    }
  }

  /**
   * The freshness row, or null — including when the client has no `mvRefreshState` delegate at all.
   *
   * That last case is not hypothetical: several unit specs construct a hand-built Prisma stub with
   * only the delegates the path under test needs, and a new read reaching through such a stub is a
   * `TypeError`, not a rejected promise, so a bare `.catch()` does not contain it. Guarding on the
   * delegate keeps this genuinely optional — #287 adds a signal, and a signal must not be able to
   * break the run it describes.
   */
  private async mvFreshnessRow(): Promise<{
    lastAttemptAt: Date | null;
    lastSuccessAt: Date | null;
    lastError: string | null;
  } | null> {
    const delegate = (this.prisma as Partial<PrismaService>).mvRefreshState;
    if (delegate?.findUnique == null) return null;
    try {
      return await delegate.findUnique({ where: { viewName: PLANT_ELIGIBLE_FLOATING_SE_MV } });
    } catch {
      return null;
    }
  }

  /** Active zones = zones with at least one plant (the only zones that can carry dispatchable work). */
  private async activeZoneIds(): Promise<bigint[]> {
    const rows = await this.prisma.plant.findMany({ distinct: ['zoneId'], select: { zoneId: true }, orderBy: { zoneId: 'asc' } });
    return rows.map((r) => r.zoneId);
  }
}

