import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Van Stock + Common Kit (Issue 21, schema D12). Reads the components an SE carries (`se_van_stock`)
 * and computes Common-Kit completeness against the active `common_kit_definition` — the source the
 * Recommender Common-Kit Hard Filter consumes, and the SE mobile Home badge. Also owns the
 * Component-Blocked Queue: tickets the Recommender dropped because the eligible SE's kit is incomplete.
 *
 * Stock is read-only to the SE and mutated only via inventory transactions (Issue 22/24); this slice
 * provides reads + the queue, not consumption.
 */
export interface VanStockItem {
  componentId: string;
  name: string;
  qty: number;
}

export interface CommonKitMissing {
  componentId: string;
  name: string;
  shortBy: number;
}

export interface CommonKitStatus {
  complete: boolean;
  missing: CommonKitMissing[];
}

export interface ComponentBlockedRow {
  id: string;
  ticketId: string;
  seId: string;
  companyName: string;
  zoneName: string;
  reason: string;
  missingComponents: CommonKitMissing[];
  wmActionStatus: string;
  blockedAt: Date;
  ageDays: number;
  warehouseOverdue: boolean;
}

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  /** The components an SE currently carries, with quantities (SE mobile read). */
  async vanStockFor(seId: string): Promise<VanStockItem[]> {
    const rows = await this.prisma.seVanStock.findMany({
      where: { seId },
      include: { component: true },
      orderBy: { component: { name: 'asc' } },
    });
    return rows.map((r) => ({ componentId: String(r.componentId), name: r.component.name, qty: r.qty }));
  }

  /**
   * Common-Kit completeness for an SE: every active kit component must be carried at ≥ its `min_qty`.
   * With no active kit definition, the kit is trivially complete (no requirement) — so the Hard Filter
   * never grounds an SE until Operations Head configures a kit.
   */
  async commonKitStatus(seId: string): Promise<CommonKitStatus> {
    const kit = await this.prisma.commonKitDefinition.findMany({ where: { active: true }, include: { component: true } });
    if (kit.length === 0) return { complete: true, missing: [] };
    // An SE with no van-stock records at all is "inventory not yet tracked" — don't ground them on a
    // data gap (seam-default philosophy). Once the SE carries anything, the kit check fully applies.
    const anyStock = await this.prisma.seVanStock.count({ where: { seId } });
    if (anyStock === 0) return { complete: true, missing: [] };
    const stock = await this.prisma.seVanStock.findMany({
      where: { seId, componentId: { in: kit.map((k) => k.componentId) } },
    });
    const qtyBy = new Map(stock.map((s) => [String(s.componentId), s.qty]));
    const missing = kit
      .map((k) => ({ k, have: qtyBy.get(String(k.componentId)) ?? 0 }))
      .filter(({ k, have }) => have < k.minQty)
      .map(({ k, have }) => ({ componentId: String(k.componentId), name: k.component.name, shortBy: k.minQty - have }));
    return { complete: missing.length === 0, missing };
  }

  /**
   * The Component-Blocked Queue for the ZM dashboard (Issue 21). Active blocks only, zone-scoped (a
   * ZONAL_MANAGER sees their own zone), oldest first. A row aged > 7 days with no Warehouse-Manager
   * action gains the `warehouseOverdue` flag (→ Action Required).
   */
  async componentBlockedQueue(
    scope: { role: string; zoneId: number | null },
    now: Date = new Date(),
  ): Promise<ComponentBlockedRow[]> {
    const restrictZone = scope.role === 'ZONAL_MANAGER' ? scope.zoneId : null;
    const rows = await this.prisma.componentBlockedQueue.findMany({
      where: {
        resolvedAt: null,
        ...(restrictZone != null ? { ticket: { plant: { zoneId: BigInt(restrictZone) } } } : {}),
      },
      include: { ticket: { include: { plant: { include: { zone: true } }, company: true } } },
      orderBy: { blockedAt: 'asc' },
    });
    const OVERDUE_MS = 7 * 24 * 60 * 60 * 1000;
    return rows.map((r) => {
      const ageDays = (now.getTime() - r.blockedAt.getTime()) / (24 * 60 * 60 * 1000);
      return {
        id: String(r.id),
        ticketId: r.ticketId,
        seId: r.seId,
        companyName: r.ticket.company.name,
        zoneName: r.ticket.plant.zone.name,
        reason: r.reason,
        missingComponents: r.missingComponents as unknown as CommonKitMissing[],
        wmActionStatus: r.wmActionStatus,
        blockedAt: r.blockedAt,
        ageDays: Math.floor(ageDays),
        warehouseOverdue: now.getTime() - r.blockedAt.getTime() > OVERDUE_MS && r.wmActionStatus === 'PENDING',
      };
    });
  }

  /** Record (or refresh) a Component-Blocked Queue row for a ticket dropped on Common-Kit grounds. */
  async recordComponentBlock(
    ticketId: string,
    seId: string,
    missing: CommonKitMissing[],
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    const existing = await tx.componentBlockedQueue.findFirst({ where: { ticketId, resolvedAt: null } });
    const missingJson = missing as unknown as Prisma.InputJsonValue;
    if (existing) {
      await tx.componentBlockedQueue.update({
        where: { id: existing.id },
        data: { seId, missingComponents: missingJson },
      });
    } else {
      await tx.componentBlockedQueue.create({
        data: { ticketId, seId, reason: 'COMMON_KIT_INCOMPLETE', missingComponents: missingJson },
      });
    }
  }

  /** Resolve any active block for a ticket (it became assignable — kit restocked / reassigned). */
  async resolveComponentBlock(ticketId: string, now: Date = new Date(), tx: Prisma.TransactionClient = this.prisma): Promise<void> {
    await tx.componentBlockedQueue.updateMany({
      where: { ticketId, resolvedAt: null },
      data: { resolvedAt: now },
    });
  }
}
