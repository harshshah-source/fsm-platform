import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { seedOrgReferenceData } from '../src/org/org-seed';

/**
 * Issue 02 Slice 10 — reference/org seed (AC#7). The seed must load the canonical fixture and be
 * idempotent: running it twice leaves exactly one of each keyed row, so CI / dev re-seeds are safe.
 */
describe('Issue 02 Slice 10 — org reference seed', () => {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('loads canonical reference data and is idempotent', async () => {
    await seedOrgReferenceData(prisma);
    await seedOrgReferenceData(prisma);

    const north = await prisma.zone.findUnique({ where: { name: 'North' } });
    expect(north).not.toBeNull();

    const acmeRows = await prisma.company.findMany({ where: { name: 'Acme Logistics' } });
    expect(acmeRows).toHaveLength(1);
    expect(acmeRows[0].companyTier).toBe('PLATINUM');

    const platinumSla = await prisma.slaRuleConfig.findMany({
      where: { scope: 'company_tier', key: 'PLATINUM' },
    });
    expect(platinumSla).toHaveLength(1);
    expect(platinumSla[0].submitWithinMinutes).toBe(30);

    const v1Weights = await prisma.priorityRuleConfig.findMany({
      where: { weightSetRef: 'v1' },
    });
    expect(v1Weights.length).toBeGreaterThanOrEqual(3);

    const kit = await prisma.commonKitDefinition.findMany({
      where: { componentId: { in: [1n, 2n, 3n, 4n] } },
    });
    expect(kit).toHaveLength(4);

    // Representative geography for the Floating-SE territory selector (Issue 09): idempotent, with
    // district→region rollup wired.
    const konkan = await prisma.region.findMany({ where: { name: 'Konkan' } });
    expect(konkan).toHaveLength(1);
    expect(konkan[0].state).toBe('Maharashtra');

    const mumbai = await prisma.district.findMany({ where: { name: 'Mumbai City', state: 'Maharashtra' } });
    expect(mumbai).toHaveLength(1);
    expect(mumbai[0].regionId).toBe(konkan[0].regionId);
  });
});
