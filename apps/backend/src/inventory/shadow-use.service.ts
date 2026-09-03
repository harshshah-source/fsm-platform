import { Injectable } from '@nestjs/common';
import type { ManagerScope } from '../common/manager-scope';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Shadow Use Queue (CONTEXT §Shadow Use Queue, Issue 24). The Warehouse Manager's view of unreconciled
 * SHADOW_USE inventory rows — components a 409-loser SE physically consumed. The WM marks each
 * RECONCILED (genuine duplicate effort) or DISPUTED (mismatch with the winning SE's report → escalate
 * to the Zonal Manager and flag the Ticket with an Inventory Dispute event).
 *
 * #353 closed two doors this left open. A dispute now **restores** the losing SE's van stock in the
 * same transaction, with a compensating ledger row, so the ledger and the shelf agree again; and the
 * queue is readable by the Zonal Manager a dispute escalates *to*, clamped to their own zone.
 */
export interface ShadowUseRow {
  id: string;
  ticketId: string | null;
  seId: string | null;
  componentId: string | null;
  componentName: string | null;
  qty: number;
  companyName: string | null;
  zoneName: string | null;
  status: string;
  reason: string | null;
  /** Who a DISPUTED row was escalated to — the ZM adjudicates; null on every other status. */
  escalatedTo: string | null;
  /** The Warehouse Manager who disputed it (`reconciled_by`), null until a decision is taken. */
  escalatedBy: string | null;
  /** When the decision was taken — the row's last write. Null until it leaves SHADOW_USE. */
  escalatedAt: Date | null;
  createdAt: Date;
  ageDays: number;
}

export type ShadowUseOutcome = { result: 'OK' } | { result: 'NOT_FOUND' } | { result: 'INVALID_STATE'; status: string };

/**
 * The statuses a caller may list. Bookkeeping rows (`SHADOW_USE_DISPUTE_RESTORE`) are deliberately
 * absent: a restore is the consequence of a decision, never work waiting for one.
 */
export const LISTABLE_STATUSES = ['SHADOW_USE', 'RECONCILED', 'DISPUTED'] as const;
export type ListableStatus = (typeof LISTABLE_STATUSES)[number];

export function isListableStatus(value: string): value is ListableStatus {
  return (LISTABLE_STATUSES as readonly string[]).includes(value);
}

export interface ShadowUseQuery {
  /** Defaults to SHADOW_USE — the Warehouse Manager's unreconciled work queue. */
  status?: ListableStatus;
  /** A ZM is clamped to their own zone (via ticket → plant → zone); CSM / OH see every zone. */
  scope?: ManagerScope;
  now?: Date;
}

@Injectable()
export class ShadowUseService {
  constructor(private readonly prisma: PrismaService) {}

  /** Ledger rows in one status, newest first, with ticket / SE / component context. */
  async queue(query: ShadowUseQuery = {}): Promise<ShadowUseRow[]> {
    const now = query.now ?? new Date();
    const rows = await this.prisma.inventoryTransaction.findMany({
      where: { status: query.status ?? 'SHADOW_USE', ...zoneClamp(query.scope) },
      include: { component: true, ticket: { include: { company: true, plant: { include: { zone: true } } } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({
      id: String(r.id),
      ticketId: r.ticketId,
      seId: r.seId,
      componentId: r.componentId != null ? String(r.componentId) : null,
      componentName: r.component?.name ?? null,
      qty: r.qty,
      companyName: r.ticket?.company.name ?? null,
      zoneName: r.ticket?.plant.zone.name ?? null,
      status: r.status,
      reason: r.reason,
      escalatedTo: r.status === 'DISPUTED' ? 'ZONAL_MANAGER' : null,
      escalatedBy: r.status === 'SHADOW_USE' ? null : r.reconciledBy,
      escalatedAt: r.status === 'SHADOW_USE' ? null : r.updatedAt,
      createdAt: r.createdAt,
      ageDays: Math.floor((now.getTime() - r.createdAt.getTime()) / (24 * 60 * 60 * 1000)),
    }));
  }

  /** SHADOW_USE → RECONCILED (genuine duplicate effort). */
  async markReconciled(id: string, actor: { userId: string; role: string }, now: Date = new Date()): Promise<ShadowUseOutcome> {
    const existing = await this.prisma.inventoryTransaction.findUnique({ where: { id: BigInt(id) } });
    if (!existing) return { result: 'NOT_FOUND' };
    if (existing.status !== 'SHADOW_USE') return { result: 'INVALID_STATE', status: existing.status };
    await this.prisma.$transaction(async (tx) => {
      await tx.inventoryTransaction.update({ where: { id: BigInt(id) }, data: { status: 'RECONCILED', reconciledBy: actor.userId } });
      await tx.auditLog.create({
        data: { actorId: actor.userId, actorRole: actor.role, action: 'SHADOW_USE_RECONCILED', entityType: 'inventory_transactions', entityId: id, metadata: { ticketId: existing.ticketId, at: now.toISOString() } },
      });
    });
    return { result: 'OK' };
  }

  /**
   * SHADOW_USE → DISPUTED: the consumption doesn't match the winning SE's report. Escalates to the ZM
   * (audit) and flags the Ticket with an Inventory Dispute event so it surfaces on the ticket timeline.
   *
   * #353 — and puts the part back. A dispute says the SE should not have been charged for it, so the
   * charge is compensated in the same transaction: `se_van_stock` goes back up by exactly the
   * decremented quantity and a `SHADOW_USE_DISPUTE_RESTORE` row records that it did. Before this the
   * status flipped, the ZM was told, and the part stayed charged against the engineer's van forever —
   * a permanent disagreement between the ledger and the shelf that only a physical count would find.
   * The pattern is `verification.service.ts`'s failed-verification rollback; the difference is that a
   * dispute keeps its DISPUTED row (it is the WM's decision, and the ZM's queue), so the restore is a
   * second row rather than a status change on the first.
   */
  async markDisputed(id: string, reason: string, actor: { userId: string; role: string }, now: Date = new Date()): Promise<ShadowUseOutcome> {
    const existing = await this.prisma.inventoryTransaction.findUnique({ where: { id: BigInt(id) } });
    if (!existing) return { result: 'NOT_FOUND' };
    if (existing.status !== 'SHADOW_USE') return { result: 'INVALID_STATE', status: existing.status };
    const restorable = existing.seId !== null && existing.componentId !== null;
    await this.prisma.$transaction(async (tx) => {
      await tx.inventoryTransaction.update({ where: { id: BigInt(id) }, data: { status: 'DISPUTED', reconciledBy: actor.userId, reason } });
      if (restorable) {
        const seId = existing.seId!;
        const componentId = existing.componentId!;
        await tx.seVanStock.upsert({
          where: { seId_componentId: { seId, componentId } },
          create: { seId, componentId, qty: existing.qty },
          update: { qty: { increment: existing.qty } },
        });
        await tx.inventoryTransaction.create({
          data: {
            seId,
            componentId,
            qty: existing.qty,
            ticketId: existing.ticketId,
            submissionId: existing.submissionId,
            type: existing.type,
            status: 'SHADOW_USE_DISPUTE_RESTORE',
            reason,
            reconciledBy: actor.userId,
          },
        });
      }
      if (existing.ticketId) {
        // No-transition timeline marker: the Ticket gains an "Inventory Dispute" flag without changing
        // its lifecycle state (from === to), carried by the reason code.
        const ticket = await tx.ticket.findUnique({ where: { ticketId: existing.ticketId }, select: { status: true } });
        await tx.ticketEvent.create({
          data: {
            ticketId: existing.ticketId,
            fromState: ticket?.status ?? null,
            toState: ticket?.status ?? 'VERIFICATION_PENDING',
            at: now,
            actorId: actor.userId,
            actorRole: actor.role as never,
            reasonCode: 'INVENTORY_DISPUTE',
          },
        });
      }
      await tx.auditLog.create({
        data: {
          actorId: actor.userId,
          actorRole: actor.role,
          action: 'SHADOW_USE_DISPUTED',
          entityType: 'inventory_transactions',
          entityId: id,
          metadata: {
            ticketId: existing.ticketId,
            reason,
            escalatedTo: 'ZONAL_MANAGER',
            restoredQty: restorable ? existing.qty : 0,
            at: now.toISOString(),
          },
        },
      });
    });
    return { result: 'OK' };
  }
}

/**
 * A ZM sees only their own zone, resolved through the row's ticket → plant → zone. A row with no
 * ticket has no zone to belong to, so it stays out of a zone-clamped read rather than leaking into
 * every one of them.
 */
function zoneClamp(scope: ShadowUseQuery['scope']): Prisma.InventoryTransactionWhereInput {
  if (!scope || scope.role !== 'ZONAL_MANAGER' || scope.zoneId === null) return {};
  return { ticket: { plant: { zoneId: BigInt(scope.zoneId) } } };
}
