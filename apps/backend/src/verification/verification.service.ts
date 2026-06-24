import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { evaluatePhase1, evaluatePhase2 } from './verification-criteria';

/**
 * VerificationWorker (Issue 18, LLD §17). Re-entrant scan of VERIFICATION_PENDING Troubleshoot tickets:
 * watches the named device's pings after the SE's form submission and drives the three-phase outcome.
 * Phase state lives in `verification_runs` (one in-flight run per ticket), so each scan recomputes from
 * the pings — safe to run every few minutes. Terminal outcomes transition the ticket + cycle and audit.
 *
 * No scheduler here (same posture as the rest of P1–P3); `runVerification(now)` is invoked on demand /
 * by tests; a BullMQ 5-min cron wires to it when scheduling lands.
 */
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export interface VerificationSweepResult {
  closed: number;
  failed: number;
  fraud: number;
  pending: number;
}

@Injectable()
export class VerificationService {
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

    const result: VerificationSweepResult = { closed: 0, failed: 0, fraud: 0, pending: 0 };
    for (const ticket of tickets) {
      const outcome = await this.verifyTicket(ticket, now);
      if (outcome === 'CLOSED') result.closed++;
      else if (outcome === 'FRAUD') {
        result.failed++;
        result.fraud++;
      } else if (outcome === 'FAILED') result.failed++;
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
    await this.prisma.$transaction(async (tx) => {
      await tx.ticket.update({ where: { ticketId }, data: { status: 'ESCALATED', lastStateChangedAt: now } });
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
    });
    return 'OK';
  }

  /**
   * Mark a verification-review row as auto-recovered (Issue 19): the ZM judges the device recovered on
   * its own (no SE credit). Closes the ticket CLOSED_AUTO_RECOVERY, cycle VERIFIED, and stamps the run
   * outcome CLOSED_AUTO_RECOVERY. Zone-scoped; distinct from Issue 08's pre-submission auto-recovery.
   */
  async markAutoRecovery(
    ticketId: string,
    actor: { userId: string; role: string },
    scope: { role: string; zoneId: number | null },
  ): Promise<'OK' | 'NOT_FOUND'> {
    const ticket = await this.prisma.ticket.findUnique({ where: { ticketId }, include: { plant: true } });
    if (!ticket) return 'NOT_FOUND';
    if (scope.role === 'ZONAL_MANAGER' && scope.zoneId != null && Number(ticket.plant.zoneId) !== scope.zoneId) {
      return 'NOT_FOUND';
    }
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.ticket.update({ where: { ticketId }, data: { status: 'CLOSED_AUTO_RECOVERY', lastStateChangedAt: now } });
      if (ticket.failureCycleId) {
        await tx.failureCycle.update({ where: { cycleId: ticket.failureCycleId }, data: { state: 'VERIFIED', closedAt: now } });
        await tx.deviceState.updateMany({ where: { deviceId: ticket.deviceId }, data: { hasOpenFailureCycle: false } });
      }
      await tx.verificationRun.updateMany({
        where: { ticketId, outcome: null },
        data: { outcome: 'CLOSED_AUTO_RECOVERY', outcomeAt: now },
      });
      await tx.ticketEvent.create({
        data: { ticketId, fromState: ticket.status, toState: 'CLOSED_AUTO_RECOVERY', at: now, actorId: actor.userId, actorRole: actor.role as never, reasonCode: 'MANUAL_AUTO_RECOVERY' },
      });
      await tx.auditLog.create({
        data: { actorId: actor.userId, actorRole: actor.role, action: 'MANUAL_AUTO_RECOVERY', entityType: 'tickets', entityId: ticketId },
      });
    });
    return 'OK';
  }

  private async verifyTicket(
    ticket: { ticketId: string; deviceId: bigint; failureCycleId: string | null; status: string },
    now: Date,
  ): Promise<'CLOSED' | 'FRAUD' | 'FAILED' | 'PENDING'> {
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

    const baseUpdate: Prisma.VerificationRunUpdateInput = {
      pingsReceivedCount: p1.pingsCount,
      firstPingDistanceMeters: p1.firstPingDistanceMeters,
    };

    // Phase-1 fraud: first ping wildly off the SE anchor.
    if (p1.fraud) {
      return this.finalize(ticket, run.runId, { ...baseUpdate, fraudFlag: true }, 'FAILED_VERIFICATION', now, 'FRAUD');
    }

    const expired = now.getTime() - run.startedAt.getTime() >= TWENTY_FOUR_HOURS_MS;

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
    ticket: { ticketId: string; deviceId: bigint },
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

  /** Persist the terminal run outcome and transition the ticket (+ cycle on CLOSED), audited, one tx. */
  private async finalize(
    ticket: { ticketId: string; failureCycleId: string | null; status: string; deviceId: bigint },
    runId: string,
    runData: Prisma.VerificationRunUpdateInput,
    outcome: 'CLOSED' | 'FAILED_VERIFICATION',
    now: Date,
    tag: 'CLOSED' | 'FAILED' | 'FRAUD',
  ): Promise<'CLOSED' | 'FAILED' | 'FRAUD'> {
    const ticketStatus = outcome === 'CLOSED' ? 'CLOSED' : 'FAILED_VERIFICATION';
    await this.prisma.$transaction(async (tx) => {
      await tx.verificationRun.update({
        where: { runId },
        data: { ...runData, outcome, outcomeAt: now },
      });
      await tx.ticket.update({ where: { ticketId: ticket.ticketId }, data: { status: ticketStatus, lastStateChangedAt: now } });
      if (outcome === 'CLOSED' && ticket.failureCycleId) {
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
          await tx.seVanStock.upsert({
            where: { seId_componentId: { seId: txn.seId, componentId: txn.componentId } },
            create: { seId: txn.seId, componentId: txn.componentId, qty: txn.qty },
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
    return tag;
  }
}
