import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface TierOverrideExpirySweepResult {
  expired: number;
}

/**
 * Issue 157 S4 — the auto-revert-at-expiry sweep (Q1: "revert silently but audit the auto-revert").
 * Because `effective-tier.ts`'s resolvers already predicate on `expiresAt`, not `status`, an
 * override is inert the instant it expires REGARDLESS of whether this sweep has run — flipping
 * `status` here changes nothing about what tier is effective (AC-3's sweep-lag pin,
 * `test/effective-tier-resolver.spec.ts`, proves that identically). This sweep exists purely so
 * `status` stays truthful for the report/audit trail, not for correctness.
 *
 * Q-B (live reads only) also holds here: no ticket is re-stamped. `tickets.company_tier` keeps its
 * effective-tier-at-creation snapshot for the ticket's lifetime — an override lapsing does not
 * retroactively touch any existing ticket (AC-5).
 */
@Injectable()
export class TierOverrideExpiryService {
  constructor(private readonly prisma: PrismaService) {}

  async sweepExpiredOverrides(now: Date = new Date()): Promise<TierOverrideExpirySweepResult> {
    const rows = await this.prisma.companyTierOverride.findMany({
      where: { status: 'ACTIVE', expiresAt: { lte: now } },
      select: { id: true, companyId: true, zoneId: true, tier: true, expiresAt: true },
    });
    if (rows.length === 0) return { expired: 0 };

    const ids = rows.map((r) => r.id);
    await this.prisma.$transaction(async (tx) => {
      await tx.companyTierOverride.updateMany({
        where: { id: { in: ids } },
        data: { status: 'EXPIRED' },
      });
      // Actor = system (Q1) — a scheduled sweep, not an admin action. Batched like the device-departure
      // sweep's audit write: one transaction, one insert, for however many rows this tick found.
      await tx.auditLog.createMany({
        data: rows.map((r) => ({
          actorId: 'SYSTEM',
          actorRole: 'SYSTEM',
          action: 'TIER_OVERRIDE_EXPIRED',
          entityType: 'company_tier_overrides',
          entityId: r.id.toString(),
          metadata: {
            companyId: r.companyId.toString(),
            zoneId: r.zoneId.toString(),
            tier: r.tier,
            expiresAt: r.expiresAt.toISOString(),
          },
        })),
      });
    });
    return { expired: rows.length };
  }
}
