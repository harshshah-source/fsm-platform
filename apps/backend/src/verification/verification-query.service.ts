import { Injectable } from '@nestjs/common';
import type { VerificationBadge, VerificationCheck, VerificationView } from '@fsm/shared';
import { Prisma } from '../generated/prisma/client';
import { type VerifyOutcome, type VerifyPhase } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { PHASE1_MIN_PINGS } from './verification-criteria';

export type { VerificationBadge, VerificationCheck, VerificationView } from '@fsm/shared';

/** 24 h escalation window for a PARTIAL_RECOVERY ticket — the countdown anchor on the review page. */
const PARTIAL_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface VerificationReviewScope {
  role: string;
  zoneId: number | null;
}

export interface VerificationReviewFilters {
  /** Default (omitted) = all non-CLOSED for the zone. */
  outcome?: 'PARTIAL_RECOVERY' | 'FAILED_VERIFICATION' | 'CLOSED' | 'CLOSED_AUTO_RECOVERY';
  companyId?: bigint;
  /** OPERATIONS_HEAD / CSM may narrow to a zone; a ZONAL_MANAGER is always pinned to their own. */
  zoneId?: bigint;
  dateFrom?: Date;
  dateTo?: Date;
}

export type VerificationRowType =
  | 'PARTIAL_RECOVERY'
  | 'FAILED_NO_PINGS'
  | 'FAILED_FRAUD'
  | 'CLOSED'
  | 'CLOSED_AUTO_RECOVERY'
  | 'PENDING';

export interface VerificationReviewRow {
  ticketId: string;
  deviceId: string;
  companyName: string;
  zoneId: string;
  zoneName: string;
  outcome: VerifyOutcome | null;
  phase: VerifyPhase;
  pingsReceivedCount: number;
  fraudFlag: boolean;
  firstPingDistanceMeters: number | null;
  startedAt: Date;
  rowType: VerificationRowType;
  /** For PARTIAL_RECOVERY: startedAt + 24 h — the review-page countdown; null otherwise. */
  partialDeadline: Date | null;
}

function rowTypeFor(outcome: VerifyOutcome | null, fraud: boolean, pings: number): VerificationRowType {
  if (outcome === 'CLOSED') return 'CLOSED';
  if (outcome === 'CLOSED_AUTO_RECOVERY') return 'CLOSED_AUTO_RECOVERY';
  if (outcome === 'FAILED_VERIFICATION') return fraud ? 'FAILED_FRAUD' : 'FAILED_NO_PINGS';
  if (!outcome && pings >= 1 && pings <= 2) return 'PARTIAL_RECOVERY';
  return 'PENDING';
}

/**
 * Read surface for verification outcomes (Issue 18). Backs the SE/ZM ticket verification view and the
 * ZM fraud-flags list. The PARTIAL_RECOVERY badge is **derived** from `pings_received_count` + `outcome`
 * (1–2 pings while still in flight) — never a stored lifecycle state (CONTEXT §Partial Recovery).
 */
/** Caller identity for `forTicket`'s row-scoping (#162 — this read was previously unscoped for every role). */
export interface VerificationReadScope {
  role: string;
  userId: string;
  zoneId: number | null;
}

export interface FraudFlagView {
  ticketId: string;
  deviceId: string;
  firstPingDistanceMeters: number | null;
  outcome: VerifyOutcome | null;
  outcomeAt: Date | null;
  /**
   * #357 — the zone the flagged ticket belongs to. Load-bearing now that the list is clamped: a CSM /
   * Operations Head reading every zone's flags needs to know which zone each row came from, and a ZM
   * reading their own can be *shown* the clamp rather than asked to trust it.
   */
  zoneId: string;
  zoneName: string;
  /** #357 — why this run's ticket is escalated right now; null when it is not under escalation. */
  escalationReason: string | null;
}

function badgeFor(pings: number, outcome: VerifyOutcome | null): VerificationBadge {
  if (outcome) return outcome;
  if (pings >= 1 && pings <= 2) return 'PARTIAL_RECOVERY';
  return null;
}

/**
 * #59 / #172 Decision 4 — the mobile "VERIFICATION CHECKS" list. Only the 3 checks with a real
 * source in `verification-criteria.ts` ship (2026-08-04 operator decision) — "Device mapping
 * verified" and "Historical mapping checked" from the reference image have no defined signal and
 * are omitted, not guessed. A check is `FAIL` only once the run has concluded (`outcome` set) and
 * it never passed; otherwise `PENDING` — never claim a failure the run hasn't actually reached yet.
 */
function buildChecks(run: { pingsReceivedCount: number; phase: VerifyPhase; outcome: VerifyOutcome | null }): VerificationCheck[] {
  const concluded = run.outcome !== null;
  const state = (passed: boolean): VerificationCheck['state'] => (passed ? 'PASS' : concluded ? 'FAIL' : 'PENDING');
  return [
    { key: 'live_gps', label: 'Live GPS received', state: state(run.pingsReceivedCount >= 1) },
    { key: 'multiple_pings', label: 'Multiple pings detected', state: state(run.pingsReceivedCount >= PHASE1_MIN_PINGS) },
    { key: 'stability_window', label: 'Stability window', state: state(run.phase === 'PHASE_2_PASS') },
  ];
}

@Injectable()
export class VerificationQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Latest verification run for a ticket, with the derived badge; null if none yet — or if the caller
   * is out of scope for this ticket, which the controller maps to the same 404 as "no run" (#162: this
   * route was unscoped for EVERY role, not just SE — `@CurrentUser()` wasn't even injected). SE: own
   * submission, own RECOVERY assignment, or own batch assignment. ZONAL_MANAGER: own zone (mirrors
   * `review()` / `escalateFraud`). CSM / OPERATIONS_HEAD: unrestricted, as elsewhere.
   */
  async forTicket(ticketId: string, scope: VerificationReadScope): Promise<VerificationView | null> {
    const ticket = await this.prisma.ticket.findUnique({
      where: { ticketId },
      select: { assignedSeId: true, plant: { select: { zoneId: true } } },
    });
    if (!ticket || !(await this.inScope(ticketId, ticket, scope))) return null;

    const run = await this.prisma.verificationRun.findFirst({
      where: { ticketId },
      orderBy: { startedAt: 'desc' },
    });
    if (!run) return null;
    const badge = badgeFor(run.pingsReceivedCount, run.outcome);
    return {
      ticketId,
      deviceId: String(run.deviceId),
      phase: run.phase,
      pingsReceivedCount: run.pingsReceivedCount,
      outcome: run.outcome,
      fraudFlag: run.fraudFlag,
      firstPingDistanceMeters: run.firstPingDistanceMeters == null ? null : Number(run.firstPingDistanceMeters),
      badge,
      checks: buildChecks(run),
      startedAt: run.startedAt.toISOString(),
      partialDeadline: badge === 'PARTIAL_RECOVERY' ? new Date(run.startedAt.getTime() + PARTIAL_WINDOW_MS).toISOString() : null,
    };
  }

  private async inScope(
    ticketId: string,
    ticket: { assignedSeId: string | null; plant: { zoneId: bigint } },
    scope: VerificationReadScope,
  ): Promise<boolean> {
    if (scope.role === 'SERVICE_ENGINEER') {
      if (ticket.assignedSeId === scope.userId) return true; // RECOVERY assignment
      const submission = await this.prisma.troubleshootingSubmission.findFirst({
        where: { ticketId, seId: scope.userId },
        select: { submissionId: true },
      });
      if (submission) return true; // own troubleshoot submission
      const batchTicket = await this.prisma.batchAssignmentTicket.findFirst({
        where: { ticketId, batch: { seId: scope.userId } },
        select: { id: true },
      });
      return !!batchTicket; // TROUBLESHOOT/INSTALL batch assignment
    }
    if (scope.role === 'ZONAL_MANAGER') {
      return scope.zoneId == null || Number(ticket.plant.zoneId) === scope.zoneId;
    }
    return true; // CENTRAL_SERVICE_MANAGER / OPERATIONS_HEAD — unrestricted, as elsewhere
  }

  /**
   * The ZM Verification Review list (Issue 19). Zone-scoped (a ZONAL_MANAGER sees only their own zone);
   * filterable by outcome / company / date; default = all non-CLOSED, newest first. Each row carries a
   * derived `rowType` (PARTIAL_RECOVERY / FAILED_NO_PINGS / FAILED_FRAUD / CLOSED / auto-recovery) and a
   * 24 h partial-recovery countdown deadline.
   */
  async review(filters: VerificationReviewFilters, scope: VerificationReviewScope): Promise<VerificationReviewRow[]> {
    const restrictZone = scope.role === 'ZONAL_MANAGER' ? scope.zoneId : (filters.zoneId != null ? Number(filters.zoneId) : null);

    const where: Prisma.VerificationRunWhereInput = {
      ...(filters.outcome ? { outcome: filters.outcome } : { OR: [{ outcome: null }, { outcome: { not: 'CLOSED' } }] }),
      ...(filters.dateFrom || filters.dateTo
        ? { startedAt: { ...(filters.dateFrom ? { gte: filters.dateFrom } : {}), ...(filters.dateTo ? { lte: filters.dateTo } : {}) } }
        : {}),
      ticket: {
        ...(filters.companyId != null ? { companyId: filters.companyId } : {}),
        ...(restrictZone != null ? { plant: { zoneId: BigInt(restrictZone) } } : {}),
      },
    };

    const runs = await this.prisma.verificationRun.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      include: { ticket: { include: { company: true, plant: { include: { zone: true } } } } },
    });

    return runs.map((r) => ({
      ticketId: r.ticketId,
      deviceId: String(r.deviceId),
      companyName: r.ticket.company.name,
      zoneId: String(r.ticket.plant.zoneId),
      zoneName: r.ticket.plant.zone.name,
      outcome: r.outcome,
      phase: r.phase,
      pingsReceivedCount: r.pingsReceivedCount,
      fraudFlag: r.fraudFlag,
      firstPingDistanceMeters: r.firstPingDistanceMeters == null ? null : Number(r.firstPingDistanceMeters),
      startedAt: r.startedAt,
      rowType: rowTypeFor(r.outcome, r.fraudFlag, r.pingsReceivedCount),
      partialDeadline:
        !r.outcome && r.pingsReceivedCount >= 1 && r.pingsReceivedCount <= 2
          ? new Date(r.startedAt.getTime() + PARTIAL_WINDOW_MS)
          : null,
    }));
  }

  /**
   * Phase-1 location-mismatch fraud flags for the ZM fraud-flags view.
   *
   * #357 — zone-scoped, the same clamp {@link review} and {@link forTicket} already applied. This read
   * took no scope at all, so a ZONAL_MANAGER opening their own fraud queue was served every zone's
   * flags: a privacy leak (fraud suspicion against engineers they do not manage) and, just as bad
   * operationally, a queue nobody owns — rows a ZM cannot act on, because `escalateFraud` and
   * `markAutoRecovery` both 404 out of zone. The clamp is deliberately expressed exactly as `review`
   * expresses it, so "which zones may I see" has one definition in this file rather than three.
   */
  async fraudFlags(scope: VerificationReviewScope): Promise<FraudFlagView[]> {
    const restrictZone = scope.role === 'ZONAL_MANAGER' ? scope.zoneId : null;
    const runs = await this.prisma.verificationRun.findMany({
      where: {
        fraudFlag: true,
        ...(restrictZone != null ? { ticket: { plant: { zoneId: BigInt(restrictZone) } } } : {}),
      },
      orderBy: { outcomeAt: 'desc' },
      include: { ticket: { include: { plant: { include: { zone: true } } } } },
    });
    return runs.map((r) => ({
      ticketId: r.ticketId,
      deviceId: String(r.deviceId),
      firstPingDistanceMeters: r.firstPingDistanceMeters == null ? null : Number(r.firstPingDistanceMeters),
      outcome: r.outcome,
      outcomeAt: r.outcomeAt,
      zoneId: String(r.ticket.plant.zoneId),
      zoneName: r.ticket.plant.zone.name,
      escalationReason: r.escalationReason,
    }));
  }
}
