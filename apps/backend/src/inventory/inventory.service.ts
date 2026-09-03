import { Injectable, Optional } from '@nestjs/common';
import type { CommonKitMissing, CommonKitStatus, VanStockItem } from '@fsm/shared';
import { Prisma } from '../generated/prisma/client';
import { NotificationService } from '../notifications/notification.service';
import { PRD_NOTICE_TYPES, queueNoticeOnce } from '../notifications/prd-event-notice';
import { PrismaService } from '../prisma/prisma.service';
import { drainProducerRows } from '../scheduling/day-plan-notification-outbox';

export type { CommonKitMissing, CommonKitStatus, VanStockItem } from '@fsm/shared';

/**
 * Van Stock + Common Kit (Issue 21, schema D12). Reads the components an SE carries (`se_van_stock`)
 * and computes Common-Kit completeness against the active `common_kit_definition` — the source the
 * Recommender Common-Kit Hard Filter consumes, and the SE mobile Home badge. Also owns the
 * Component-Blocked Queue: tickets the Recommender dropped because the eligible SE's kit is incomplete.
 *
 * Stock is read-only to the SE and mutated only via inventory transactions (Issue 22/24); this slice
 * provides reads + the queue, not consumption. `VanStockItem`/`CommonKitMissing`/`CommonKitStatus`
 * now live in `@fsm/shared` (#60).
 */
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
  /**
   * `@Optional()` **and** defaulted, and both halves are load-bearing.
   *
   * Defaulted, because this class is hand-constructed in four places (`recommender.service.ts`,
   * `intraday-insertion.service.ts`, `engineers-query.service.ts`, `inventory-service.e2e-spec.ts`) —
   * `RecommenderService` defaults its own `InventoryService` for the same reason.
   *
   * `@Optional()`, because `EngineersModule` and `RecommenderModule` **re-provide** `InventoryService`
   * in their own contexts without importing `NotificationsModule`, so a required parameter takes the
   * whole app down at boot with "Nest can't resolve dependencies of the InventoryService". Adding the
   * import to two modules this slice does not own was the alternative; making the dependency optional
   * is the smaller change and fails softer. Nest passes `undefined` where the binding is absent, which
   * is exactly what triggers the default — so the notice is still produced there, delivered through a
   * service built on the same client. The container's configured singleton is injected wherever
   * `InventoryModule` itself resolves this class, which is every path that matters for the channel.
   */
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly notifications: NotificationService = new NotificationService(prisma),
  ) {}

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

  /**
   * Record (or refresh) a Component-Blocked Queue row for a ticket dropped on Common-Kit grounds —
   * and, since #361 (INV-G7, absorbing #53), tell the engineer whose kit is short.
   *
   * **Why the SE and not the warehouse.** The queue row is the manager-and-warehouse view: it is what
   * the ZM dashboard lists and what the WM is expected to act on. Nobody was telling the *engineer*,
   * and the engineer is the one whose day is being silently reshaped by it — the recommender is
   * dropping work they would otherwise have been given, for a reason that exists entirely inside the
   * dispatch run. An SE who is quietly skipped for a week has no way to discover that four missing
   * SIM cards are the cause, and the fix (restock the van) is theirs to ask for.
   *
   * **Deduplicated per (ticket, IST day).** The recommender re-evaluates on every run and this row is
   * *refreshed*, not created, on each one — so an un-deduplicated enqueue here would push the same
   * engineer about the same ticket several times a day for as long as the kit stayed short. Once a day
   * is the cadence a restock decision actually moves at.
   *
   * **Opens its own transaction when the caller has none.** The recommender calls this bare (no `tx`),
   * and #338's rule is that a producer without a transaction opens one rather than deferring the
   * enqueue: the mutation is local — one queue row plus its notice — so an atomic pair is available
   * and is exactly what "enqueue inside the mutation's transaction" asks for. Given a caller's `tx`,
   * the enqueue joins it and the returned row id is the caller's to drain.
   *
   * @returns the outbox row id when a notice was enqueued, else null (already told today, or the
   *   engineer is not a notifiable user).
   */
  async recordComponentBlock(
    ticketId: string,
    seId: string,
    missing: CommonKitMissing[],
    tx?: Prisma.TransactionClient,
    now: Date = new Date(),
  ): Promise<bigint | null> {
    const write = async (client: Prisma.TransactionClient): Promise<bigint | null> => {
      const existing = await client.componentBlockedQueue.findFirst({ where: { ticketId, resolvedAt: null } });
      const missingJson = missing as unknown as Prisma.InputJsonValue;
      if (existing) {
        await client.componentBlockedQueue.update({
          where: { id: existing.id },
          data: { seId, missingComponents: missingJson },
        });
      } else {
        await client.componentBlockedQueue.create({
          data: { ticketId, seId, reason: 'COMMON_KIT_INCOMPLETE', missingComponents: missingJson },
        });
      }
      return queueNoticeOnce(
        client,
        {
          recipients: [{ userId: seId, role: 'SERVICE_ENGINEER' }],
          type: PRD_NOTICE_TYPES.commonKitShort,
          title: 'Common Kit incomplete',
          // Naming the parts is the difference between a notice and a nag: "restock" is not an action
          // until the engineer knows what is missing and by how much.
          body:
            `Your Common Kit is short of ${missing.map((m) => `${m.name} (${m.shortBy})`).join(', ')}. ` +
            `Work needing ${missing.length === 1 ? 'it' : 'them'} is not being assigned to you until the van is restocked.`,
          entityType: 'ticket',
          entityId: ticketId,
          deliveryModel: 'GENERAL',
          metadata: { seId, missing: missing as unknown as Prisma.InputJsonValue },
        },
        now,
      );
    };

    if (tx) return write(tx);

    const queued = await this.prisma.$transaction((inner) => write(inner));
    await drainProducerRows(this.prisma, { notify: this.notifications }, queued === null ? [] : [queued], now);
    return queued;
  }

  /** Resolve any active block for a ticket (it became assignable — kit restocked / reassigned). */
  async resolveComponentBlock(ticketId: string, now: Date = new Date(), tx: Prisma.TransactionClient = this.prisma): Promise<void> {
    await tx.componentBlockedQueue.updateMany({
      where: { ticketId, resolvedAt: null },
      data: { resolvedAt: now },
    });
  }
}
