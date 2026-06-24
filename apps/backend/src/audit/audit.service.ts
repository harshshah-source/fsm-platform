import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** One audit row's worth of who/what/where. `actedAsRole` carries the backup-cascade proxy. */
export interface AuditEntry {
  actorId: string;
  actorRole: string;
  actedAsRole?: string | null;
  /** Zone being acted in on a backup-cascade (acted-as) action; drives the CSM-backup report (Issue 27). */
  actingZone?: number | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata?: Prisma.InputJsonValue;
}

/**
 * In-transaction audit. `withAudit` runs the caller's mutation and the audit insert inside
 * one interactive transaction, so the audit row and the change it records commit together
 * or roll back together — there is no window where a mutation is persisted unaudited.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async withAudit<T>(
    entry: AuditEntry,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      const result = await work(tx);
      await tx.auditLog.create({
        data: {
          actorId: entry.actorId,
          actorRole: entry.actorRole,
          actedAsRole: entry.actedAsRole ?? null,
          actingZone: entry.actingZone != null ? BigInt(entry.actingZone) : null,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId,
          metadata: entry.metadata,
        },
      });
      return result;
    });
  }
}
