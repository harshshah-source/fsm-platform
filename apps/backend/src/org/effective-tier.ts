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

export interface ActiveOverride {
  tier: $Enums.CompanyTier;
  overrideId: string;
}

/** The lookup key {@link resolveActiveOverrides} keys its map by — a (company, zone) pair. */
export function tierOverrideKey(companyId: bigint, zoneId: bigint): string {
  return `${companyId}:${zoneId}`;
}

/**
 * Batched variant of {@link resolveEffectiveTier} for engine consumption sites that resolve many
 * (company, zone) pairs in one pass — the recommender's zone-run (one zone, many companies) and the
 * ticket-creation sweep (many zones, via each candidate's plant). One query for every ACTIVE,
 * unexpired override across the given zones, reduced to the newest per (company, zone) pair
 * (newest-wins, Q-A). Callers already hold each candidate's global tier from their own company
 * read, so combine as `overrides.get(tierOverrideKey(companyId, zoneId))?.tier ?? company.companyTier`.
 */
export async function resolveActiveOverrides(
  client: Pick<PrismaClient | Prisma.TransactionClient, 'companyTierOverride'>,
  zoneIds: bigint[],
  now: Date,
): Promise<Map<string, ActiveOverride>> {
  if (zoneIds.length === 0) return new Map();
  const rows = await client.companyTierOverride.findMany({
    where: { zoneId: { in: zoneIds }, status: 'ACTIVE', expiresAt: { gt: now } },
    orderBy: [{ companyId: 'asc' }, { zoneId: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, companyId: true, zoneId: true, tier: true },
  });
  const result = new Map<string, ActiveOverride>();
  for (const row of rows) {
    const key = tierOverrideKey(row.companyId, row.zoneId);
    if (!result.has(key)) result.set(key, { tier: row.tier, overrideId: row.id.toString() });
  }
  return result;
}
