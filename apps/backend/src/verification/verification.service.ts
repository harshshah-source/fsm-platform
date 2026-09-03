import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { LostRaceError, stampOnceOrLose } from '../common/lost-race';
import { PrismaService } from '../prisma/prisma.service';
import { retireAssignmentOnClosure } from '../scheduling/close-assignment';
import { foldAndResumeSlaPause } from '../ticketing/sla-pause';
import { evaluatePhase1, evaluatePhase2 } from './verification-criteria';

/**
 * VerificationWorker (Issue 18, LLD §17). Re-entrant scan of VERIFICATION_PENDING Troubleshoot tickets:
 * watches the named device's pings after the SE's form submission and drives the three-phase outcome.
 * Phase state lives in `verification_runs` (one in-flight run per ticket), so each scan recomputes from
 * the pings — safe to run every few minutes. Terminal outcomes transition the ticket + cycle and audit.
 *
 * **Scheduled.** `runVerification(now)` is driven by the `business-verification` cron
 * (`BusinessSweepSchedulerService`, gated by `BUSINESS_SWEEPS_ENABLED`), and is still callable on
 * demand and by tests. This comment claimed "no scheduler … when scheduling lands" until 2026-08-10;
 * #108 had wired it on 2026-07-07 and the prose was never updated (#229 §4). The registered job-name
 * set is asserted in `test/scheduler-wiring.e2e-spec.ts` — that assertion, not this sentence, is what
 * makes "does this run?" answerable.
 */
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export interface VerificationSweepResult {
  closed: number;
  failed: number;
  fraud: number;
  pending: number;
  /**
   * #301 — tickets this pass declined to finalize because something else transitioned them first (a
   * ZM's fraud escalation, a manual auto-recovery close, an overlapping sweep).
   *
   * A counted outcome rather than a log line, for the reason the whole slice exists: "we chose not to
   * write" and "there was nothing to write" are different facts, and a sweep that skipped half its
   * candidates must not report the same shape as one that had nothing to do (#228 R3, the same
   * argument as `PipelineSummary.ingestComplete`). Nothing is lost by skipping — the winner's verdict
   * is already recorded, and if the ticket is genuinely still pending the next pass picks it up.
   */
  skipped: number;
}

@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);

  constructor(private readonly prisma: PrismaService) {}

  async runVerification(
    now: Date = new Date(),
    opts: { ticketIds?: string[] } = {},
  ): Promise<VerificationSweepResult> {
    const tickets = await this.prisma.ticket.findMany({
      where: {
        workType: 'TROUBLESHOOT',
        status: 'VERIFICATION_PENDING',
        ...(opts.ticketIds ? { ticketId: { in: opts.ticketIds } } : {}),
      },
      select: { ticketId: true, deviceId: true, failureCycleId: true, status: true },
    });

    // #148: read the telemetry watermark ONCE per sweep, not once per ticket — it is a single global
    // value and the sweep runs every 5 minutes over every pending ticket.
    const telemetryAsOf = await this.telemetryWatermark();

    const result: VerificationSweepResult = { closed: 0, failed: 0, fraud: 0, pending: 0, skipped: 0 };
    for (const ticket of tickets) {
      const outcome = await this.verifyTicket(ticket, now, telemetryAsOf);
      if (outcome === 'CLOSED') result.closed++;
      else if (outcome === 'FRAUD') {
        result.failed++;
        result.fraud++;
      } else if (outcome === 'FAILED') result.failed++;
      else if (outcome === 'SKIPPED') result.skipped++;
      else result.pending++;
    }
    return result;
  }

  /**
   * Escalate a fraud-flagged verification (Issue 19). A ZM (own zone) / CSM / OpsHead moves the ticket
   * to ESCALATED with a mandatory reason, audited. Zone-scoped: a ZONAL_MANAGER may only act on own-zone
   * tickets (else NOT_FOUND).
   */
  async escalateFraud(
    ticketId: string,
    reason: string,
    actor: { userId: string; role: string; actedAsRole?: string | null },
    scope: { role: string; zoneId: number | null },
  ): Promise<'OK' | 'NOT_FOUND' | 'NOT_FRAUD'> {
    const ticket = await this.prisma.ticket.findUnique({
      where: { ticketId },
      include: { plant: true },
    });
    if (!ticket) return 'NOT_FOUND';
    if (scope.role === 'ZONAL_MANAGER' && scope.zoneId != null && Number(ticket.plant.zoneId) !== scope.zoneId) {
      return 'NOT_FOUND';
    }
    const run = await this.prisma.verificationRun.findFirst({
      where: { ticketId, fraudFlag: true },
      orderBy: { startedAt: 'desc' },
    });
    if (!run) return 'NOT_FRAUD';

    const now = new Date();
    try {
      await this.prisma.$transaction(async (tx) => {
        // #301 — the status is in the WHERE, not in a JS check above. `ticket.status` is what THIS
        // caller read; requiring it to be unchanged is what stops the 5-minute sweep's finalize (or a
        // concurrent auto-recovery close) from being overwritten by an escalation raised against a
        // ticket that has since moved. It is also what makes the `fromState` on the event below true —
        // that field was previously free to claim a transition the database never made.
        await stampOnceOrLose(
          tx.ticket,
          { ticketId, status: ticket.status },
          { status: 'ESCALATED', lastStateChangedAt: now },
          `fraud escalation for ticket ${ticketId}`,
        );
        await tx.ticketEvent.create({
          data: {
            ticketId,
            fromState: ticket.status,
            toState: 'ESCALATED',
            at: now,
            actorId: actor.userId,
            actorRole: actor.role as never,
            actedAsRole: (actor.actedAsRole as never) ?? null,
            reasonCode: 'VERIFICATION_FRAUD_ESCALATED',
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: actor.userId,
            actorRole: actor.role,
            actedAsRole: actor.actedAsRole ?? null,
            action: 'VERIFICATION_FRAUD_ESCALATED',
            entityType: 'tickets',
            entityId: ticketId,
            metadata: { runId: run.runId, reason },
          },
        });
        // #357 — the reason on the RUN as well as in the audit metadata. The audit row is the history
        // and stays authoritative for it; this column is the live verdict, and it is the only one the
        // outcomes report and the review queue can actually read (both aggregate `verification_runs`;
        // neither joins `audit_logs` by entity id). Same transaction, so a reason can never exist in
        // one ledger and not the other.
        await tx.verificationRun.update({
          where: { runId: run.runId },
          data: { escalationReason: reason },
        });
      });
    } catch (e) {
      // The documented lost-race mapping (`common/lost-race.ts`): the row the caller asked to act on is
      // no longer the row they read, which is the same answer their own pre-read would give a moment
      // later. No new member on the outcome union — an honest 404 where a silent overwrite used to be.
      if (e instanceof LostRaceError) return 'NOT_FOUND';
      throw e;
    }
    return 'OK';
  }

  /**
   * Mark a verification-review row as auto-recovered (Issue 19): the ZM judges the device recovered on
   * its own (no SE credit). Closes the ticket CLOSED_AUTO_RECOVERY, cycle VERIFIED, and stamps the run
   * outcome CLOSED_AUTO_RECOVERY. Zone-scoped; distinct from Issue 08's pre-submission auto-recovery.
   *
   * #357 — `reason` is mandatory (the controller rejects a missing/blank one with 400). This is a
   * manager overruling the platform's own verdict on whether work happened, which is precisely the
   * decision an auditor later asks about; the sibling door `escalateFraud` has demanded a reason since
   * Issue 19 and there was never a principled reason for this one not to.
   */
  async markAutoRecovery(
    ticketId: string,
    reason: string,
    actor: { userId: string; role: string; actedAsRole?: string | null },
    scope: { role: string; zoneId: number | null },
  ): Promise<'OK' | 'NOT_FOUND'> {
    const ticket = await this.prisma.ticket.findUnique({ where: { ticketId }, include: { plant: true } });
    if (!ticket) return 'NOT_FOUND';
    if (scope.role === 'ZONAL_MANAGER' && scope.zoneId != null && Number(ticket.plant.zoneId) !== scope.zoneId) {
      return 'NOT_FOUND';
    }
    /**
     * #357 — the run this close must agree with, read BEFORE the transaction so its outcome can be
     * used as a guard rather than as an unchecked assumption.
     *
     * The old write was `updateMany({ where: { ticketId, outcome: null } })`, which silently matched
     * nothing whenever the sweep had already concluded the run. A ticket that expired
     * FAILED_VERIFICATION and was then judged recovered ended with the run saying FAILED and the
     * ticket saying CLOSED_AUTO_RECOVERY — two permanent, contradictory records of one event, with
     * `/reports/verification-outcomes` (which aggregates the runs) publishing the failure.
     */
    const run = await this.prisma.verificationRun.findFirst({
      where: { ticketId },
      orderBy: { startedAt: 'desc' },
      select: { runId: true, outcome: true },
    });
    /**
     * Only a run that has NOT reached a positive verdict is restamped. `null` is the in-flight case the
     * original code handled; `FAILED_VERIFICATION` is the contradiction this slice closes. A `CLOSED`
     * or already-`CLOSED_AUTO_RECOVERY` run is left exactly as it is — auto-recovery must never
     * un-verify a run that genuinely passed, and re-stamping a finished auto-recovery would move its
     * `outcome_at` for no event.
     */
    const restampable = run != null && (run.outcome === null || run.outcome === 'FAILED_VERIFICATION');
    const now = new Date();
    try {
      await this.prisma.$transaction(async (tx) => {
        // #301 — guarded on the status this caller read. Without it, a sweep that finalized the ticket
        // CLOSED (or FAILED_VERIFICATION, which restores van stock) a moment ago is overwritten here,
        // and the cycle/run/assignment writes below commit against a verdict that no longer exists.
        await stampOnceOrLose(
          tx.ticket,
          { ticketId, status: ticket.status },
          { status: 'CLOSED_AUTO_RECOVERY', lastStateChangedAt: now },
          `manual auto-recovery for ticket ${ticketId}`,
        );
        if (ticket.failureCycleId) {
          await tx.failureCycle.update({ where: { cycleId: ticket.failureCycleId }, data: { state: 'VERIFIED', closedAt: now } });
          await tx.deviceState.updateMany({ where: { deviceId: ticket.deviceId }, data: { hasOpenFailureCycle: false } });
        }
        if (restampable) {
          // Guarded on the outcome THIS caller read, for the same reason the ticket stamp above is:
          // the run now moves on a path the sweep also writes, so an unguarded update by primary key
          // would let this close overwrite a verdict the sweep reached in between. A loss rolls the
          // whole transaction back — better no close at all than a ticket closed against a run that
          // says something else, which is the exact failure mode this slice exists to end.
          await stampOnceOrLose(
            tx.verificationRun,
            { runId: run.runId, outcome: run.outcome },
            { outcome: 'CLOSED_AUTO_RECOVERY', outcomeAt: now },
            `auto-recovery verdict on verification run ${run.runId}`,
          );
        }
        await tx.ticketEvent.create({
          data: { ticketId, fromState: ticket.status, toState: 'CLOSED_AUTO_RECOVERY', at: now, actorId: actor.userId, actorRole: actor.role as never, actedAsRole: (actor.actedAsRole as never) ?? null, reasonCode: 'MANUAL_AUTO_RECOVERY' },
        });
        await tx.auditLog.create({
          data: {
            actorId: actor.userId,
            actorRole: actor.role,
            actedAsRole: actor.actedAsRole ?? null,
            action: 'MANUAL_AUTO_RECOVERY',
            entityType: 'tickets',
            entityId: ticketId,
            metadata: { runId: run?.runId ?? null, reason },
          },
        });
        // #178 — the ticket is terminal, so the assignment is over: retire the live batch row and clear
        // FORMALLY_ASSIGNED in this same transaction, or the SE keeps a stop (and the recommender keeps
        // a spent capacity slot) for a device just declared recovered.
        await retireAssignmentOnClosure(tx, [ticketId], now);
      });
    } catch (e) {
      if (e instanceof LostRaceError) return 'NOT_FOUND';
      throw e;
    }
    return 'OK';
  }

  /**
   * #357 — reverse a fraud escalation raised in error. ZM (own zone) / CSM / OpsHead, mandatory reason,
   * audited, guarded.
   *
   * ESCALATED was a one-way door: `escalateFraud` could move a ticket there and nothing could move it
   * back, so a manager who escalated the wrong ticket — or escalated on an anchor GPS that later turned
   * out to be the faulty reading — left the ticket permanently parked in a state no sweep and no other
   * door will ever pick up. That is not a labelling annoyance: the ticket stops being work anyone is
   * accountable for finishing.
   *
   * **Where it goes back to.** The ticket returns to the state it was escalated FROM, read off the
   * `ticket_events` row the escalation itself wrote — not to a hardcoded VERIFICATION_PENDING. The two
   * are genuinely different: a fraud escalation is normally raised against a run that has already
   * concluded FAILED_VERIFICATION, and sending that ticket back to VERIFICATION_PENDING would invent a
   * window the sweep would then re-expire. VERIFICATION_PENDING is the fallback only when no escalation
   * event can be found (a row escalated before events were stamped), because that is the review state a
   * TROUBLESHOOT ticket sits in while it is somebody's to decide.
   *
   * **A closed ticket is refused** (`NOT_ESCALATED` → 409). Closure is terminal and reversing INTO it
   * would have to unwind a cycle close, an inventory leg and a retired assignment; that is a different
   * operation from undoing an escalation and does not get to hide inside this one.
   */
  async deescalate(
    ticketId: string,
    reason: string,
    actor: { userId: string; role: string; actedAsRole?: string | null },
    scope: { role: string; zoneId: number | null },
  ): Promise<'OK' | 'NOT_FOUND' | 'NOT_ESCALATED'> {
    const ticket = await this.prisma.ticket.findUnique({ where: { ticketId }, include: { plant: true } });
    if (!ticket) return 'NOT_FOUND';
    if (scope.role === 'ZONAL_MANAGER' && scope.zoneId != null && Number(ticket.plant.zoneId) !== scope.zoneId) {
      return 'NOT_FOUND';
    }
    // Covers the closed ticket too: a CLOSED / CLOSED_AUTO_RECOVERY / FAILED_VERIFICATION ticket is by
    // definition not currently escalated, so there is one refusal here rather than a status allowlist
    // that would need editing every time the ladder grows.
    if (ticket.status !== 'ESCALATED') return 'NOT_ESCALATED';

    const escalation = await this.prisma.ticketEvent.findFirst({
      where: { ticketId, toState: 'ESCALATED' },
      orderBy: { at: 'desc' },
      select: { fromState: true },
    });
    const previousStatus = escalation?.fromState ?? 'VERIFICATION_PENDING';

    const run = await this.prisma.verificationRun.findFirst({
      where: { ticketId },
      orderBy: { startedAt: 'desc' },
      select: { runId: true },
    });

    const now = new Date();
    try {
      await this.prisma.$transaction(async (tx) => {
        // #301's guard, applied to the new door on the day it lands rather than retrofitted: the status
        // is in the WHERE, so a sweep or a concurrent close that moved the ticket out of ESCALATED wins
        // and this de-escalation loses whole — no write, no event, no audit row.
        await stampOnceOrLose(
          tx.ticket,
          { ticketId, status: 'ESCALATED' },
          { status: previousStatus as never, lastStateChangedAt: now },
          `fraud de-escalation for ticket ${ticketId}`,
        );
        await tx.ticketEvent.create({
          data: {
            ticketId,
            fromState: 'ESCALATED',
            toState: previousStatus,
            at: now,
            actorId: actor.userId,
            actorRole: actor.role as never,
            actedAsRole: (actor.actedAsRole as never) ?? null,
            reasonCode: 'VERIFICATION_DEESCALATED',
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: actor.userId,
            actorRole: actor.role,
            actedAsRole: actor.actedAsRole ?? null,
            action: 'VERIFICATION_DEESCALATED',
            entityType: 'tickets',
            entityId: ticketId,
            metadata: { runId: run?.runId ?? null, reason, previousStatus },
          },
        });
        if (run) {
          // `escalation_reason` is the LIVE verdict, not the history — see the column's docblock. The
          // ticket is no longer escalated, so the run must not keep claiming a reason for it; the audit
          // log above and the escalation's own audit row keep the full story of both transitions.
          await tx.verificationRun.update({ where: { runId: run.runId }, data: { escalationReason: null } });
        }
      });
    } catch (e) {
      if (e instanceof LostRaceError) return 'NOT_FOUND';
      throw e;
    }
    return 'OK';
  }

  /**
   * Newest telemetry watermark — the `data_as_of` of the most recent snapshot run that recorded one.
   * Mirrors the read in `AutoPlantHealthService.snapshotHealth`, deliberately, so "how fresh is
   * telemetry" has exactly one definition on the platform. `null` = no run has ever recorded a
   * watermark.
   */
  private async telemetryWatermark(): Promise<Date | null> {
    const lastGood = await this.prisma.snapshotRun.findFirst({
      where: { dataAsOf: { not: null } },
      orderBy: { runId: 'desc' },
      select: { dataAsOf: true },
    });
    return lastGood?.dataAsOf ?? null;
  }

  /**
   * #148 — a verification window may expire only once BOTH are true: 24 h of wall-clock has elapsed,
   * AND telemetry has actually advanced past the submission.
   *
   * Wall-clock alone is not evidence. The sweep fires every 5 minutes while
   * `INGESTION_SCHEDULER_ENABLED` may be `false`, so nothing is guaranteed to be writing the
   * `raw_device_snapshots` this verdict reads. Without the second condition a device the SE genuinely
   * repaired ages into an IRREVERSIBLE `FAILED_VERIFICATION` — rolling back its `PRE_VERIFICATION`
   * inventory — purely because nobody ran the pipeline that day.
   *
   * A null watermark (no run has ever recorded one) means telemetry has NOT advanced: no ping could
   * have arrived, so expiring would be exactly the wrong verdict. Conservative by construction.
   *
   * This can only ever DELAY a failure verdict, never cause one — so it is strictly safer than the
   * behaviour it replaces, and it needs no ops discipline to hold. The cost is the opposite tail: a
   * window that never expires because the watermark never advances. That is a REAL condition being
   * correctly surfaced, not hidden — it must be made visible (slice 3), never auto-expired after a
   * grace period, which would merely re-create this bug with a longer fuse.
   */
  private windowExpired(startedAt: Date, now: Date, telemetryAsOf: Date | null): boolean {
    if (now.getTime() - startedAt.getTime() < TWENTY_FOUR_HOURS_MS) return false;
    return telemetryAsOf != null && telemetryAsOf.getTime() > startedAt.getTime();
  }

  private async verifyTicket(
    ticket: { ticketId: string; deviceId: string; failureCycleId: string | null; status: string },
    now: Date,
    telemetryAsOf: Date | null,
  ): Promise<'CLOSED' | 'FRAUD' | 'FAILED' | 'PENDING' | 'SKIPPED'> {
    // Phase-1 anchor: the latest troubleshoot submission for this ticket.
    const submission = await this.prisma.troubleshootingSubmission.findFirst({
      where: { ticketId: ticket.ticketId },
      orderBy: { submittedAt: 'desc' },
    });
    if (!submission) return 'PENDING';

    const run = await this.getOrCreateRun(ticket, submission, now);

    const pings = await this.prisma.rawDeviceSnapshot.findMany({
      where: { deviceId: ticket.deviceId, gpsDatetime: { gt: submission.submittedAt } },
      select: { gpsDatetime: true, lat: true, lon: true },
      orderBy: { gpsDatetime: 'asc' },
    });

    const hasAnchor = submission.seGpsLat != null && submission.seGpsLon != null;
    const skipGeoCheck = submission.presenceSource === 'NONE' || !hasAnchor;
    const p1 = evaluatePhase1({
      pings: pings.map((p) => ({ time: p.gpsDatetime, lat: p.lat, lon: p.lon })),
      anchor: hasAnchor ? { lat: submission.seGpsLat!, lon: submission.seGpsLon! } : null,
      skipGeoCheck,
    });

    const baseUpdate: Prisma.VerificationRunUpdateManyMutationInput = {
      pingsReceivedCount: p1.pingsCount,
      firstPingDistanceMeters: p1.firstPingDistanceMeters,
    };

    // Phase-1 fraud: first ping wildly off the SE anchor.
    if (p1.fraud) {
      return this.finalize(ticket, run.runId, { ...baseUpdate, fraudFlag: true }, 'FAILED_VERIFICATION', now, 'FRAUD');
    }

    const expired = this.windowExpired(run.startedAt, now, telemetryAsOf);

    if (!p1.passed) {
      // 1–2 pings (partial badge) or none — fail only once the 24 h window expires; else keep watching.
      if (expired) {
        return this.finalize(ticket, run.runId, baseUpdate, 'FAILED_VERIFICATION', now, 'FAILED');
      }
      await this.prisma.verificationRun.update({ where: { runId: run.runId }, data: baseUpdate });
      return 'PENDING';
    }

    // Phase 1 passed — anchor the stability window on the first ping.
    const phase1Start = pings[0].gpsDatetime;
    const p2 = evaluatePhase2({ pingTimes: pings.map((p) => p.gpsDatetime), phase1Start, now });

    if (p2.passed) {
      return this.finalize(
        ticket,
        run.runId,
        {
          ...baseUpdate,
          phase: 'PHASE_2_PASS',
          phase1PassedAt: run.phase1PassedAt ?? phase1Start,
          phase2PassedAt: now,
        },
        'CLOSED',
        now,
        'CLOSED',
      );
    }

    if (expired) {
      return this.finalize(ticket, run.runId, baseUpdate, 'FAILED_VERIFICATION', now, 'FAILED');
    }

    // Still stabilising (window not elapsed, or a coverage gap → stay PENDING, never auto-fail).
    await this.prisma.verificationRun.update({
      where: { runId: run.runId },
      data: { ...baseUpdate, phase: 'PHASE_1_PASS', phase1PassedAt: run.phase1PassedAt ?? phase1Start },
    });
    return 'PENDING';
  }

  private async getOrCreateRun(
    ticket: { ticketId: string; deviceId: string },
    submission: { submissionId: string; submittedAt: Date; seGpsLat: number | null; seGpsLon: number | null },
    now: Date,
  ) {
    const existing = await this.prisma.verificationRun.findFirst({
      where: { ticketId: ticket.ticketId, outcome: null },
    });
    if (existing) return existing;
    return this.prisma.verificationRun.create({
      data: {
        ticketId: ticket.ticketId,
        submissionId: submission.submissionId,
        deviceId: ticket.deviceId,
        startedAt: submission.submittedAt,
        seGpsLat: submission.seGpsLat,
        seGpsLon: submission.seGpsLon,
        phase: 'PENDING',
      },
    });
  }

  /**
   * Persist the terminal run outcome and transition the ticket (+ cycle on CLOSED), audited, one tx.
   *
   * #301 — both terminal writes are guarded, and the guards come FIRST so nothing else in the
   * transaction can commit against a verdict that lost. The ticket guard is `status` as the candidate
   * scan read it (`VERIFICATION_PENDING`); the run guard is `outcome: null`, matching the one
   * `markAutoRecovery` already used. A loss throws {@link LostRaceError}, which rolls the whole
   * per-ticket transaction back — cycle close, assignment retirement, ticket event, audit row **and**
   * the inventory leg. That last one is why this is corruption and not a labelling bug: a lost
   * FAILED_VERIFICATION would otherwise restore the SE's van stock against a CLOSED that says the
   * components were consumed.
   */
  private async finalize(
    ticket: { ticketId: string; failureCycleId: string | null; status: string; deviceId: string },
    runId: string,
    runData: Prisma.VerificationRunUpdateManyMutationInput,
    outcome: 'CLOSED' | 'FAILED_VERIFICATION',
    now: Date,
    tag: 'CLOSED' | 'FAILED' | 'FRAUD',
  ): Promise<'CLOSED' | 'FAILED' | 'FRAUD' | 'SKIPPED'> {
    const ticketStatus = outcome === 'CLOSED' ? 'CLOSED' : 'FAILED_VERIFICATION';
    try {
      await this.prisma.$transaction(async (tx) => {
        await stampOnceOrLose(
          tx.verificationRun,
          { runId, outcome: null },
          { ...runData, outcome, outcomeAt: now },
          `verification run ${runId}`,
        );
        await stampOnceOrLose(
          tx.ticket,
          { ticketId: ticket.ticketId, status: ticket.status },
          { status: ticketStatus, lastStateChangedAt: now },
          `verification ${tag} for ticket ${ticket.ticketId}`,
        );
        // #178 — CLOSED and FAILED_VERIFICATION are both terminal, so the assignment ends here. This is
        // the highest-volume closure in the product and the largest source of the phantom live rows.
        await retireAssignmentOnClosure(tx, [ticket.ticketId], now);
        if (outcome === 'CLOSED' && ticket.failureCycleId) {
          // #271 (Q7 Case 1) — terminal bookkeeping only. By this point submission has already folded
          // any running pause, so this is expected to be a no-op on every real path; it exists so a
          // cycle reaching VERIFIED can never carry `sla_paused = true` into closed work, whatever wrote
          // it. Generic (no `onlyReason`) on purpose — a defensive backstop that only cleared ONE reason
          // would still leave the other able to leak into downtime maths on closed work.
          await foldAndResumeSlaPause(tx, ticket.failureCycleId, now);
          await tx.failureCycle.update({ where: { cycleId: ticket.failureCycleId }, data: { state: 'VERIFIED', closedAt: now } });
          await tx.deviceState.updateMany({ where: { deviceId: ticket.deviceId }, data: { hasOpenFailureCycle: false } });
        }

        // Inventory follows the outcome (Issue 24, CONTEXT §Inventory). A verified close confirms the
        // PRE_VERIFICATION consumption as DEDUCTED; a failed verification means the device wasn't repaired,
        // so the components roll back and the SE's van stock is restored to physical reality.
        if (outcome === 'CLOSED') {
          await tx.inventoryTransaction.updateMany({
            where: { ticketId: ticket.ticketId, status: 'PRE_VERIFICATION' },
            data: { status: 'DEDUCTED' },
          });
        } else {
          const pre = await tx.inventoryTransaction.findMany({
            where: { ticketId: ticket.ticketId, status: 'PRE_VERIFICATION' },
          });
          for (const txn of pre) {
            // #353 made `se_id` / `component_id` nullable for device-keyed receipt rows. A
            // PRE_VERIFICATION row is a component consumption and always carries both; this narrows
            // the types and states that, rather than asserting it away.
            const { seId, componentId } = txn;
            if (seId === null || componentId === null) continue;
            await tx.seVanStock.upsert({
              where: { seId_componentId: { seId, componentId } },
              create: { seId, componentId, qty: txn.qty },
              update: { qty: { increment: txn.qty } },
            });
            await tx.inventoryTransaction.update({ where: { id: txn.id }, data: { status: 'ROLLED_BACK' } });
          }
        }
        await tx.ticketEvent.create({
          data: { ticketId: ticket.ticketId, fromState: ticket.status, toState: ticketStatus, at: now, reasonCode: `VERIFICATION_${tag}` },
        });
        await tx.auditLog.create({
          data: {
            actorId: 'SYSTEM',
            actorRole: 'SYSTEM',
            action: `VERIFICATION_${tag}`,
            entityType: 'tickets',
            entityId: ticket.ticketId,
            metadata: { runId },
          },
        });
      });
    } catch (e) {
      if (e instanceof LostRaceError) {
        // Not an error: somebody else already decided this ticket. Nothing to undo (the transaction
        // rolled back), nothing to retry — if it is genuinely still pending, the next 5-minute pass
        // picks it up from its real current state.
        this.logger.warn(`${e.message} — verification ${tag} not recorded, the concurrent winner stands`);
        return 'SKIPPED';
      }
      throw e;
    }
    return tag;
  }
}
