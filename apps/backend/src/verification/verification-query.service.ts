import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { type VerifyOutcome, type VerifyPhase } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

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
export type VerificationBadge = VerifyOutcome | 'PARTIAL_RECOVERY' | null;

export interface VerificationView {
  ticketId: string;
  phase: VerifyPhase;
  pingsReceivedCount: number;
  outcome: VerifyOutcome | null;
  fraudFlag: boolean;
  firstPingDistanceMeters: number | null;
  /** What the mobile renders: the final outcome, or a PARTIAL_RECOVERY badge while 1–2 pings are in. */
  badge: VerificationBadge;
}

export interface FraudFlagView {
  ticketId: string;
  deviceId: string;
  firstPingDistanceMeters: number | null;
  outcome: VerifyOutcome | null;
  outcomeAt: Date | null;
}

function badgeFor(pings: number, outcome: VerifyOutcome | null): VerificationBadge {
  if (outcome) return outcome;
  if (pings >= 1 && pings <= 2) return 'PARTIAL_RECOVERY';
  return null;
}

@Injectable()
export class VerificationQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /** Latest verification run for a ticket, with the derived badge; null if none yet. */
  async forTicket(ticketId: string): Promise<VerificationView | null> {
    const run = await this.prisma.verificationRun.findFirst({
      where: { ticketId },
      orderBy: { startedAt: 'desc' },
    });
    if (!run) return null;
    return {
      ticketId,
      phase: run.phase,
      pingsReceivedCount: run.pingsReceivedCount,
      outcome: run.outcome,
      fraudFlag: run.fraudFlag,
      firstPingDistanceMeters: run.firstPingDistanceMeters == null ? null : Number(run.firstPingDistanceMeters),
      badge: badgeFor(run.pingsReceivedCount, run.outcome),
    };
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

  /** Phase-1 location-mismatch fraud flags for the ZM fraud-flags view. */
  async fraudFlags(): Promise<FraudFlagView[]> {
    const runs = await this.prisma.verificationRun.findMany({
      where: { fraudFlag: true },
      orderBy: { outcomeAt: 'desc' },
    });
    return runs.map((r) => ({
      ticketId: r.ticketId,
      deviceId: String(r.deviceId),
      firstPingDistanceMeters: r.firstPingDistanceMeters == null ? null : Number(r.firstPingDistanceMeters),
      outcome: r.outcome,
      outcomeAt: r.outcomeAt,
    }));
  }
}
