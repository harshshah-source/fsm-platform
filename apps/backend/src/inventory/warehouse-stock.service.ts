import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface WarehouseStockScope {
  role: string;
  zoneId: number | null;
}

/** One per-zone SKU stock level (Issue 73). `available` = on_hand − reserved; `lowStock` = available ≤ threshold. */
export interface WarehouseStockRow {
  zoneId: string;
  zoneName: string;
  componentId: string;
  componentName: string;
  onHand: number;
  reserved: number;
  available: number;
  lowStockThreshold: number;
  lowStock: boolean;
}

export interface WarehouseStockPatch {
  onHand?: number;
  reserved?: number;
  lowStockThreshold?: number;
}

export type SetStockOutcome = { result: 'OK'; row: WarehouseStockRow } | { result: 'NOT_FOUND' };

/** Component-Request fulfilment timeliness (Issue 73 KPI), derived from `component_request` timestamps. */
export interface FulfillmentSla {
  totalReceived: number;
  withinSlaPct: number;
  avgFulfillmentHours: number | null;
  openRequests: number;
  slaWindowDays: number;
}

interface StockWithRelations {
  zoneId: bigint;
  componentId: bigint;
  onHand: number;
  reserved: number;
  lowStockThreshold: number;
  zone: { name: string };
  component: { name: string };
}

function toRow(s: StockWithRelations): WarehouseStockRow {
  const available = s.onHand - s.reserved;
  return {
    zoneId: String(s.zoneId),
    zoneName: s.zone.name,
    componentId: String(s.componentId),
    componentName: s.component.name,
    onHand: s.onHand,
    reserved: s.reserved,
    available,
    lowStockThreshold: s.lowStockThreshold,
    lowStock: available <= s.lowStockThreshold,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Zone-warehouse stock (Issue 73). WM-managed per-zone SKU levels (on-hand / reserved / low-stock
 * threshold) with an audited manual set/adjust, plus the Component-Request Fulfilment-SLA KPI derived
 * from the `component_request` timestamps. Zone-scoped like the other manager reads. The automated
 * Mother→Zone replenishment flow is future — v1 on-hand is set by the Warehouse Manager.
 */
@Injectable()
export class WarehouseStockService {
  private readonly audit: AuditService;

  constructor(private readonly prisma: PrismaService) {
    this.audit = new AuditService(prisma);
  }

  async listStock(scope: WarehouseStockScope): Promise<WarehouseStockRow[]> {
    const where: Prisma.ZoneWarehouseStockWhereInput =
      scope.role === 'ZONAL_MANAGER' && scope.zoneId !== null ? { zoneId: BigInt(scope.zoneId) } : {};
    const rows = await this.prisma.zoneWarehouseStock.findMany({
      where,
      include: { zone: { select: { name: true } }, component: { select: { name: true } } },
      orderBy: [{ zoneId: 'asc' }, { componentId: 'asc' }],
    });
    return rows.map(toRow);
  }

  async setStock(
    zoneId: bigint,
    componentId: bigint,
    patch: WarehouseStockPatch,
    actor: { userId: string; role: string; actedAsRole?: string | null },
  ): Promise<SetStockOutcome> {
    const [zone, component] = await Promise.all([
      this.prisma.zone.findUnique({ where: { zoneId } }),
      this.prisma.componentMaster.findUnique({ where: { componentId } }),
    ]);
    if (!zone || !component) return { result: 'NOT_FOUND' };

    const saved = await this.audit.withAudit(
      {
        actorId: actor.userId,
        actorRole: actor.role,
        actedAsRole: actor.actedAsRole ?? null,
        action: 'WAREHOUSE_STOCK_SET',
        entityType: 'zone_warehouse_stock',
        entityId: `${zoneId}:${componentId}`,
        metadata: patch as Prisma.InputJsonValue,
      },
      (tx) =>
        tx.zoneWarehouseStock.upsert({
          where: { zoneId_componentId: { zoneId, componentId } },
          create: {
            zoneId,
            componentId,
            onHand: patch.onHand ?? 0,
            reserved: patch.reserved ?? 0,
            lowStockThreshold: patch.lowStockThreshold ?? 0,
          },
          update: {
            ...(patch.onHand !== undefined ? { onHand: patch.onHand } : {}),
            ...(patch.reserved !== undefined ? { reserved: patch.reserved } : {}),
            ...(patch.lowStockThreshold !== undefined ? { lowStockThreshold: patch.lowStockThreshold } : {}),
          },
          include: { zone: { select: { name: true } }, component: { select: { name: true } } },
        }),
    );
    return { result: 'OK', row: toRow(saved) };
  }

  async fulfillmentSla(slaWindowDays = 7): Promise<FulfillmentSla> {
    const received = await this.prisma.componentRequest.findMany({
      where: { status: 'RECEIVED', receivedAt: { not: null } },
      select: { createdAt: true, receivedAt: true },
    });
    let within = 0;
    let sumHours = 0;
    for (const r of received) {
      const hours = (r.receivedAt!.getTime() - r.createdAt.getTime()) / 3_600_000;
      sumHours += hours;
      if (hours <= slaWindowDays * 24) within += 1;
    }
    const openRequests = await this.prisma.componentRequest.count({
      where: { status: { in: ['REQUESTED', 'APPROVED', 'SHIPPED'] } },
    });
    return {
      totalReceived: received.length,
      withinSlaPct: received.length ? round2((within / received.length) * 100) : 0,
      avgFulfillmentHours: received.length ? round2(sumHours / received.length) : null,
      openRequests,
      slaWindowDays,
    };
  }
}
