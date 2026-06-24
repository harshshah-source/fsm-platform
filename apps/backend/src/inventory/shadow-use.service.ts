import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Shadow Use Queue (CONTEXT §Shadow Use Queue, Issue 24). The Warehouse Manager's view of unreconciled
 * SHADOW_USE inventory rows — components a 409-loser SE physically consumed. The WM marks each
 * RECONCILED (genuine duplicate effort) or DISPUTED (mismatch with the winning SE's report → escalate
 * to the Zonal Manager and flag the Ticket with an Inventory Dispute event).
 */
export interface ShadowUseRow {
  id: string;
  ticketId: string | null;
  seId: string;
  componentId: string | null;
  componentName: string | null;
  qty: number;
  companyName: string | null;
  zoneName: string | null;
  status: string;
  reason: string | null;
  createdAt: Date;
  ageDays: number;
}

export type ShadowUseOutcome = { result: 'OK' } | { result: 'NOT_FOUND' } | { result: 'INVALID_STATE'; status: string };

@Injectable()
export class ShadowUseService {
  constructor(private readonly prisma: PrismaService) {}

  /** Unreconciled SHADOW_USE rows, newest first, with ticket / SE / component context. */
  async queue(now: Date = new Date()): Promise<ShadowUseRow[]> {
    const rows = await this.prisma.inventoryTransaction.findMany({
      where: { status: 'SHADOW_USE' },
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
   */
  async markDisputed(id: string, reason: string, actor: { userId: string; role: string }, now: Date = new Date()): Promise<ShadowUseOutcome> {
    const existing = await this.prisma.inventoryTransaction.findUnique({ where: { id: BigInt(id) } });
    if (!existing) return { result: 'NOT_FOUND' };
    if (existing.status !== 'SHADOW_USE') return { result: 'INVALID_STATE', status: existing.status };
    await this.prisma.$transaction(async (tx) => {
      await tx.inventoryTransaction.update({ where: { id: BigInt(id) }, data: { status: 'DISPUTED', reconciledBy: actor.userId, reason } });
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
        data: { actorId: actor.userId, actorRole: actor.role, action: 'SHADOW_USE_DISPUTED', entityType: 'inventory_transactions', entityId: id, metadata: { ticketId: existing.ticketId, reason, escalatedTo: 'ZONAL_MANAGER', at: now.toISOString() } },
      });
    });
    return { result: 'OK' };
  }
}
