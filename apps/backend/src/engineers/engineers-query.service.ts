import { Injectable } from '@nestjs/common';
import { type CoverageType } from '../generated/prisma/enums';
import { type CommonKitMissing, InventoryService, type VanStockItem } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { type ActivityStatus, deriveActivityStatus, resolveShiftEnd } from '../soft-state/activity-status';
import { SeAvailabilityService } from './se-availability.service';

export interface EngineerScope {
  role: string;
  zoneId: number | null;
}

export interface EngineerListRow {
  seId: string;
  name: string;
  zoneId: string;
  coverageType: CoverageType;
  /** Render-time derived label (never stored) — availability + soft states + ping + shift. */
  activityStatus: ActivityStatus;
  /** Stored planning flag (the active window's status, else AVAILABLE). */
  availabilityStatus: string;
  /** Open tickets in the SE's current (active) day-plan batches. */
  activeTicketCount: number;
  kitComplete: boolean;
  missingKit: CommonKitMissing[];
  dailyCapacity: number;
  isActive: boolean;
}

export interface AvailabilityRow {
  status: string;
  windowStart: string;
  windowEnd: string | null;
  reason: string | null;
  setByRole: string | null;
}

export interface EngineerDetail {
  seId: string;
  name: string;
  zoneId: string;
  coverageType: CoverageType;
  dailyCapacity: number;
  isActive: boolean;
  activityStatus: ActivityStatus;
  availabilityStatus: string;
  dayPlan: { status: string | null; ticketCount: number };
  vanStock: VanStockItem[];
  kit: { complete: boolean; missing: { componentId: string; name: string; shortBy: number }[] };
  availabilityRows: AvailabilityRow[];
}

/**
 * SE Management reads (Issue 25, AC#1/#2). The zone-scoped SE list with the render-time derived
 * Activity Status (reusing the pure `deriveActivityStatus`), the stored availability, today's
 * day-plan ticket count, and the Common-Kit chip. A ZONAL_MANAGER sees only their own zone;
 * cross-zone roles (CSM / Operations Head) see all.
 */
@Injectable()
export class EngineersQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: SeAvailabilityService = new SeAvailabilityService(prisma),
    private readonly inventory: InventoryService = new InventoryService(prisma),
  ) {}

  async listForZone(scope: EngineerScope, now: Date = new Date()): Promise<EngineerListRow[]> {
    const engineers = await this.prisma.engineerMaster.findMany({
      where: this.zoneFilter(scope),
      include: { user: { select: { name: true } } },
      orderBy: { engineerId: 'asc' },
    });
    const seIds = engineers.map((e) => e.engineerId);
    if (seIds.length === 0) return [];

    const availabilityBySe = await this.availability.currentStatusMany(seIds, now);
    const softStatesBySe = await this.activeSoftStatesBySe(seIds);
    const ticketCountBySe = await this.activeTicketCountBySe(seIds);
    const kitBySe = new Map(
      await Promise.all(seIds.map(async (id) => [id, await this.inventory.commonKitStatus(id)] as const)),
    );

    return engineers.map((e) => {
      const availabilityStatus = availabilityBySe.get(e.engineerId) ?? 'AVAILABLE';
      const kit = kitBySe.get(e.engineerId);
      return {
        seId: e.engineerId,
        name: e.user.name,
        zoneId: String(e.zoneId),
        coverageType: e.coverageType,
        activityStatus: deriveActivityStatus({
          availabilityStatus,
          activeSoftStateTypes: softStatesBySe.get(e.engineerId) ?? [],
          lastActivityAt: e.lastActivityAt,
          shiftEnd: resolveShiftEnd(e.shiftEnd, now),
          now,
        }),
        availabilityStatus,
        activeTicketCount: ticketCountBySe.get(e.engineerId) ?? 0,
        kitComplete: kit?.complete ?? true,
        missingKit: kit?.missing ?? [],
        dailyCapacity: e.dailyCapacity,
        isActive: e.isActive,
      };
    });
  }

  /**
   * SE detail panel (AC#2): current Day Plan status + ticket count, per-component Van Stock, the
   * Common-Kit chip, and the SE's recent availability windows. Zone-scoped — a ZM requesting an SE
   * outside their zone gets null (→ 404).
   */
  async getDetail(seId: string, scope: EngineerScope, now: Date = new Date()): Promise<EngineerDetail | null> {
    const engineer = await this.prisma.engineerMaster.findFirst({
      where: { engineerId: seId, ...this.zoneFilter(scope) },
      include: { user: { select: { name: true } } },
    });
    if (!engineer) return null;

    const availabilityStatus = await this.availability.currentStatus(seId, now);
    const activeSoftStateTypes = (await this.prisma.softState.findMany({
      where: { seId, resolvedAt: null },
      select: { type: true },
    })).map((s) => s.type);
    const vanStock = await this.inventory.vanStockFor(seId);
    const kit = await this.inventory.commonKitStatus(seId);
    const dayPlan = await this.currentDayPlan(seId);
    const rows = await this.prisma.seAvailability.findMany({
      where: { seId },
      orderBy: { windowStart: 'desc' },
      take: 10,
    });

    return {
      seId,
      name: engineer.user.name,
      zoneId: String(engineer.zoneId),
      coverageType: engineer.coverageType,
      dailyCapacity: engineer.dailyCapacity,
      isActive: engineer.isActive,
      availabilityStatus,
      activityStatus: deriveActivityStatus({
        availabilityStatus,
        activeSoftStateTypes,
        lastActivityAt: engineer.lastActivityAt,
        shiftEnd: resolveShiftEnd(engineer.shiftEnd, now),
        now,
      }),
      dayPlan,
      vanStock,
      kit,
      availabilityRows: rows.map((r) => ({
        status: r.status,
        windowStart: r.windowStart.toISOString(),
        windowEnd: r.windowEnd ? r.windowEnd.toISOString() : null,
        reason: r.reason,
        setByRole: r.setByRole,
      })),
    };
  }

  /** The SE's current active Work Schedule status + its open-ticket count (null status = none active). */
  private async currentDayPlan(seId: string): Promise<{ status: string | null; ticketCount: number }> {
    const schedule = await this.prisma.workSchedule.findFirst({
      where: { seId, status: { in: ['ACTIVE', 'OVERRIDDEN'] } },
      orderBy: { dispatchedAt: 'desc' },
      include: {
        batches: {
          where: { status: { in: ['AUTO_ASSIGNED', 'OVERRIDDEN'] } },
          include: { tickets: { where: { removedAt: null }, select: { ticketId: true } } },
        },
      },
    });
    if (!schedule) return { status: null, ticketCount: 0 };
    const ticketCount = schedule.batches.reduce((n, b) => n + b.tickets.length, 0);
    return { status: schedule.status, ticketCount };
  }

  /** Active (unresolved) soft-state types per SE. */
  private async activeSoftStatesBySe(seIds: string[]): Promise<Map<string, import('../generated/prisma/enums').SoftStateType[]>> {
    const rows = await this.prisma.softState.findMany({
      where: { seId: { in: seIds }, resolvedAt: null },
      select: { seId: true, type: true },
    });
    const map = new Map<string, import('../generated/prisma/enums').SoftStateType[]>();
    for (const r of rows) {
      const list = map.get(r.seId) ?? [];
      list.push(r.type);
      map.set(r.seId, list);
    }
    return map;
  }

  /** Count of OPEN tickets in each SE's active day-plan batches. */
  private async activeTicketCountBySe(seIds: string[]): Promise<Map<string, number>> {
    const batches = await this.prisma.plantBatchAssignment.findMany({
      where: {
        seId: { in: seIds },
        status: { in: ['AUTO_ASSIGNED', 'OVERRIDDEN'] },
        schedule: { status: { in: ['ACTIVE', 'OVERRIDDEN'] } },
      },
      include: { tickets: { where: { removedAt: null }, select: { ticketId: true } } },
    });
    const map = new Map<string, number>();
    for (const b of batches) {
      map.set(b.seId, (map.get(b.seId) ?? 0) + b.tickets.length);
    }
    return map;
  }

  private zoneFilter(scope: EngineerScope): { zoneId?: bigint } {
    return scope.role === 'ZONAL_MANAGER' && scope.zoneId != null ? { zoneId: BigInt(scope.zoneId) } : {};
  }
}
