import { Injectable } from '@nestjs/common';
import { type SeAvailabilityStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

/**
 * SE planning availability (ADR-0010, CONTEXT §SE Availability, Issue 25). Writes time-windowed
 * availability rows and derives the current status (the active window's status, else AVAILABLE) — the
 * value the Recommender Hard Filter and the derived Activity Status consume. Only the Zonal Manager
 * (own-zone) or the SE themselves may write; Operations Head has no role here.
 */
export interface SetAvailabilityInput {
  seId: string;
  status: SeAvailabilityStatus;
  windowStart: Date;
  windowEnd?: Date | null;
  reason?: string | null;
}

export interface AvailabilityActor {
  userId: string;
  role: string;
  zoneId: number | null;
  actedAsRole?: string | null;
}

export type SetAvailabilityOutcome = { result: 'OK'; id: string } | { result: 'FORBIDDEN' } | { result: 'NOT_FOUND' };

@Injectable()
export class SeAvailabilityService {
  constructor(private readonly prisma: PrismaService) {}

  /** The SE's current planning status: the active window's status (else AVAILABLE). */
  async currentStatus(seId: string, now: Date = new Date()): Promise<SeAvailabilityStatus> {
    const row = await this.prisma.seAvailability.findFirst({
      where: { seId, windowStart: { lte: now }, OR: [{ windowEnd: null }, { windowEnd: { gt: now } }] },
      orderBy: { windowStart: 'desc' },
    });
    return row?.status ?? 'AVAILABLE';
  }

  /** Current status for a set of SEs in one query (for the Recommender / SE list). */
  async currentStatusMany(seIds: string[], now: Date = new Date()): Promise<Map<string, SeAvailabilityStatus>> {
    const rows = await this.prisma.seAvailability.findMany({
      where: { seId: { in: seIds }, windowStart: { lte: now }, OR: [{ windowEnd: null }, { windowEnd: { gt: now } }] },
      orderBy: { windowStart: 'desc' },
    });
    const out = new Map<string, SeAvailabilityStatus>();
    for (const r of rows) if (!out.has(r.seId)) out.set(r.seId, r.status); // first = latest windowStart
    return out;
  }

  /**
   * Write an availability window. Authorised only for the SE themselves or a Zonal Manager over their
   * own zone (a CSM acting as ZM is treated as ZM). Operations Head is never a setter (CONTEXT).
   */
  async setAvailability(input: SetAvailabilityInput, actor: AvailabilityActor): Promise<SetAvailabilityOutcome> {
    const engineer = await this.prisma.engineerMaster.findUnique({ where: { engineerId: input.seId } });
    if (!engineer) return { result: 'NOT_FOUND' };

    const effectiveRole = actor.actedAsRole ?? actor.role;
    const allowed =
      (actor.role === 'SERVICE_ENGINEER' && actor.userId === input.seId) ||
      (effectiveRole === 'ZONAL_MANAGER' && (actor.zoneId === null || Number(engineer.zoneId) === actor.zoneId)) ||
      effectiveRole === 'CENTRAL_SERVICE_MANAGER';
    if (!allowed) return { result: 'FORBIDDEN' };

    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.seAvailability.create({
        data: {
          seId: input.seId,
          status: input.status,
          windowStart: input.windowStart,
          windowEnd: input.windowEnd ?? null,
          reason: input.reason ?? null,
          setBy: actor.userId.length === 36 ? actor.userId : null,
          setByRole: actor.actedAsRole ?? actor.role,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: actor.userId,
          actorRole: actor.role,
          actedAsRole: actor.actedAsRole ?? null,
          action: 'SE_AVAILABILITY_SET',
          entityType: 'se_availability',
          entityId: String(row.id),
          metadata: { seId: input.seId, status: input.status },
        },
      });
      return row;
    });
    return { result: 'OK', id: String(created.id) };
  }
}
