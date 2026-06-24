import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface ZmScope {
  role: string;
  zoneId: number | null;
}

export interface ZmScheduleRow {
  scheduleId: string;
  seId: string;
  zoneId: string;
  dateFrom: string;
  dateTo: string;
  status: string;
  batchCount: number;
  ticketCount: number;
}

export interface ZoneEngineerRow {
  engineerId: string;
  coverageType: string;
  zoneId: string;
  dailyCapacity: number;
  isActive: boolean;
}

export interface TicketReasoning {
  companyTier: string | null;
  deviceBucket: string | null;
  companyPriorityRank: string | null;
  clusterMultiplier: number | null;
}

export interface ZmDetailStop {
  batchId: string;
  stopSequence: number;
  plantId: string;
  plantName: string;
  status: string;
  deviceCount: number;
  tickets: { ticketId: string; sortOrder: number; reasoning: TicketReasoning | null }[];
}

export interface ZmScheduleDetail {
  scheduleId: string;
  seId: string;
  status: string;
  dateFrom: string;
  dateTo: string;
  stops: ZmDetailStop[];
}

const ACTIVE_STATUSES = ['ACTIVE', 'OVERRIDDEN'] as const;

/**
 * ZM Batch-Schedule monitoring reads (Issue 13a AC#1/#2). Per-SE schedule rows and the ordered-stop
 * detail with the per-ticket "Why suggested?" Recommender reasoning. Monitoring only — no approval or
 * countdown semantics. Zone-scoped: a ZONAL_MANAGER sees only their own zone; cross-zone roles
 * (CENTRAL_SERVICE_MANAGER / OPERATIONS_HEAD) see all zones.
 */
@Injectable()
export class ZmScheduleQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async listSchedules(scope: ZmScope): Promise<ZmScheduleRow[]> {
    const schedules = await this.prisma.workSchedule.findMany({
      where: { status: { in: [...ACTIVE_STATUSES] }, ...this.zoneFilter(scope) },
      orderBy: [{ zoneId: 'asc' }, { seId: 'asc' }],
      include: {
        batches: {
          where: { status: { in: ['AUTO_ASSIGNED', 'OVERRIDDEN'] } },
          include: { tickets: { where: { removedAt: null }, select: { id: true } } },
        },
      },
    });

    return schedules.map((s) => ({
      scheduleId: String(s.scheduleId),
      seId: s.seId,
      zoneId: String(s.zoneId),
      dateFrom: s.dateFrom.toISOString().slice(0, 10),
      dateTo: s.dateTo.toISOString().slice(0, 10),
      status: s.status,
      batchCount: s.batches.length,
      ticketCount: s.batches.reduce((n, b) => n + b.tickets.length, 0),
    }));
  }

  async getScheduleDetail(engineerId: string, scope: ZmScope): Promise<ZmScheduleDetail | null> {
    const schedule = await this.prisma.workSchedule.findFirst({
      where: { seId: engineerId, status: { in: [...ACTIVE_STATUSES] }, ...this.zoneFilter(scope) },
      orderBy: { dispatchedAt: 'desc' },
      include: {
        batches: {
          where: { status: { in: ['AUTO_ASSIGNED', 'OVERRIDDEN'] } },
          orderBy: { stopSequence: 'asc' },
          include: {
            plant: { select: { name: true } },
            tickets: {
              where: { removedAt: null },
              orderBy: { sortOrder: 'asc' },
              select: { ticketId: true, sortOrder: true },
            },
          },
        },
      },
    });
    if (!schedule) return null;

    const ticketIds = schedule.batches.flatMap((b) => b.tickets.map((t) => t.ticketId));
    const reasoning = await this.reasoningByTicket(ticketIds);

    const stops: ZmDetailStop[] = schedule.batches.map((b) => ({
      batchId: String(b.batchId),
      stopSequence: b.stopSequence,
      plantId: String(b.plantId),
      plantName: b.plant.name,
      status: b.status,
      deviceCount: b.tickets.length,
      tickets: b.tickets.map((t) => ({
        ticketId: t.ticketId,
        sortOrder: t.sortOrder,
        reasoning: reasoning.get(t.ticketId) ?? null,
      })),
    }));

    return {
      scheduleId: String(schedule.scheduleId),
      seId: schedule.seId,
      status: schedule.status,
      dateFrom: schedule.dateFrom.toISOString().slice(0, 10),
      dateTo: schedule.dateTo.toISOString().slice(0, 10),
      stops,
    };
  }

  /**
   * Manager-readable, zone-scoped active SE list — the target-SE picker source for Swap / Reassign /
   * Split overrides and the Critical-queue assign (Issue 13b). A ZONAL_MANAGER sees only their own
   * zone; cross-zone roles (CSM / Operations Head) see all. Distinct from the Ops-Head-only
   * `/api/org/engineers`, which a ZM cannot read.
   */
  async listZoneEngineers(scope: ZmScope): Promise<ZoneEngineerRow[]> {
    const engineers = await this.prisma.engineerMaster.findMany({
      where: { isActive: true, ...this.zoneFilter(scope) },
      orderBy: { engineerId: 'asc' },
    });
    return engineers.map((e) => ({
      engineerId: e.engineerId,
      coverageType: e.coverageType,
      zoneId: String(e.zoneId),
      dailyCapacity: e.dailyCapacity,
      isActive: e.isActive,
    }));
  }

  private zoneFilter(scope: ZmScope): { zoneId?: bigint } {
    return scope.role === 'ZONAL_MANAGER' && scope.zoneId != null ? { zoneId: BigInt(scope.zoneId) } : {};
  }

  /** Latest recommendation reasoning per ticket (the "Why suggested?" chip source). */
  private async reasoningByTicket(ticketIds: string[]): Promise<Map<string, TicketReasoning>> {
    if (ticketIds.length === 0) return new Map();
    const recs = await this.prisma.recommendation.findMany({
      where: { ticketId: { in: ticketIds } },
      orderBy: { recommendationId: 'desc' },
    });
    const map = new Map<string, TicketReasoning>();
    for (const r of recs) {
      if (map.has(r.ticketId)) continue; // keep the latest (desc order)
      const b = (r.scoreBreakdown ?? {}) as Record<string, unknown>;
      map.set(r.ticketId, {
        companyTier: r.companyTier ?? null,
        deviceBucket: r.deviceBucket ?? null,
        companyPriorityRank: (b.companyPriorityRank as string) ?? null,
        clusterMultiplier: typeof b.clusterMultiplier === 'number' ? b.clusterMultiplier : null,
      });
    }
    return map;
  }
}
