import { $Enums } from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { TIER_ORDER_EFFECTIVE_PRIORITY_DESC } from '../src/recommender/canonical-sort';

/**
 * Issue 157, Slice 1 — spec-pin (AC-1). `tiers` (data), the `CompanyTier` Prisma enum, and the
 * recommender's `TIER_ORDER` array are three separate encodings of the same PRD canon
 * (CONTEXT.md:315, Decision §17 :765: Platinum > Gold > Silver). `TIER_ORDER` is deliberately
 * written reversed with a compensating comparator (canonical-sort.ts:29-30) — this test is what
 * catches a "fix" that aligns the array to the enum from silently inverting dispatch priority.
 */
describe('Issue 157 Slice 1 — tiers table / enum / TIER_ORDER agreement', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it('seeds exactly the three PRD-canon tiers with rank 1 = highest priority', async () => {
    const rows = await prisma.tier.findMany({ orderBy: { rank: 'asc' } });
    expect(rows).toEqual([
      { name: 'PLATINUM', rank: 1 },
      { name: 'GOLD', rank: 2 },
      { name: 'SILVER', rank: 3 },
    ]);
  });

  it('has exactly the same membership as the CompanyTier enum', async () => {
    const rows = await prisma.tier.findMany();
    expect(new Set(rows.map((r) => r.name))).toEqual(new Set(Object.values($Enums.CompanyTier)));
  });

  it('agrees on effective priority order with the recommender TIER_ORDER (highest first)', async () => {
    const rows = await prisma.tier.findMany({ orderBy: { rank: 'asc' } });
    expect(rows.map((r) => r.name)).toEqual(TIER_ORDER_EFFECTIVE_PRIORITY_DESC);
  });
});
