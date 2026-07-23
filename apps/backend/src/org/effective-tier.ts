import type { $Enums, Prisma, PrismaClient } from '../generated/prisma/client';

type TierReadClient = Pick<PrismaClient | Prisma.TransactionClient, 'companyTierOverride' | 'company'>;

/**
 * The single effective-tier predicate (Issue 157 AC-3): the newest ACTIVE override for
 * (companyId, zoneId) whose `expiresAt` has not yet passed, else the company's global
 * `companyTier`. Stacking is allowed (Q-A) — precedence is newest by (createdAt DESC, id DESC).
 *
 * Predicates on `expiresAt`, never the swept `status` flag: an override goes inert the instant
 * it expires even if the S4 sweep that flips `status` to EXPIRED hasn't run yet (the #130 lesson
 * — trusting a derived flag at a read boundary instead of the timestamp it is derived from).
 */
export async function resolveEffectiveTier(
  client: TierReadClient,
  companyId: bigint,
  zoneId: bigint,
  now: Date,
): Promise<$Enums.CompanyTier> {
  const override = await client.companyTierOverride.findFirst({
    where: { companyId, zoneId, status: 'ACTIVE', expiresAt: { gt: now } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { tier: true },
  });
  if (override) return override.tier;

  const company = await client.company.findUniqueOrThrow({
    where: { companyId },
    select: { companyTier: true },
  });
  return company.companyTier;
}
