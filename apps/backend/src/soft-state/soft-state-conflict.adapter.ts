import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { SoftStateConflictPort } from '../scheduling/soft-state-conflict';

/**
 * Postgres-backed SoftStateConflictPort (Issue 15 AC#7) — replaces the 13a `NoConflictSoftStatePort`
 * seam. Reports which of the given tickets currently carry an active ON_SITE / TROUBLESHOOT_STARTED
 * soft state, so a ZM override (Issue 13a §12.4) that touches one surfaces a conflict warning instead
 * of silently discarding active field work. VIEWED and resolved states do not count as a conflict.
 */
@Injectable()
export class PrismaSoftStateConflictPort implements SoftStateConflictPort {
  constructor(private readonly prisma: PrismaService) {}

  async activeOnSiteTicketIds(ticketIds: string[]): Promise<Set<string>> {
    if (ticketIds.length === 0) return new Set();
    const rows = await this.prisma.softState.findMany({
      where: {
        ticketId: { in: ticketIds },
        resolvedAt: null,
        type: { in: ['ON_SITE', 'TROUBLESHOOT_STARTED'] },
      },
      select: { ticketId: true },
      distinct: ['ticketId'],
    });
    return new Set(rows.map((r) => r.ticketId));
  }
}
