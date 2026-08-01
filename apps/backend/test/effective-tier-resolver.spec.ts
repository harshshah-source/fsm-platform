import { PrismaService } from '../src/prisma/prisma.service';
import { resolveEffectiveTier } from '../src/org/effective-tier';

/**
 * Issue 157, Slice 2 — the effective-tier resolver (AC-3). One exported predicate (the #146
 * `deferral.ts` precedent), asserted directly against the DB rather than through the HTTP surface:
 * falls back to the company's global tier with no override, newest-wins under stacking (Q-A), and
 * — the sweep-lag pin — an override whose `expiresAt` has passed does NOT apply even though its
 * `status` is still ACTIVE (the sweep that flips it to EXPIRED, S4, hasn't run yet). The predicate
 * must read `expiresAt`, never `status`, or this last case would silently re-apply a dead override.
 */
describe('Issue 157 Slice 2 — resolveEffectiveTier', () => {
  let prisma: PrismaService;
  const NS = Date.now();
  const companyName = `Resolver-${NS}`;
  let companyId: bigint;
  let zoneId: bigint;
  let otherZoneId: bigint;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    const company = await prisma.company.create({
      data: { name: companyName, companyTier: 'SILVER', companyPriorityRank: 'C' },
    });
    companyId = company.companyId;
    const north = await prisma.zone.findUniqueOrThrow({ where: { name: 'North' } });
    const south = await prisma.zone.findUniqueOrThrow({ where: { name: 'South' } });
    zoneId = north.zoneId;
    otherZoneId = south.zoneId;
  });

  afterAll(async () => {
    await prisma.companyTierOverride.deleteMany({ where: { companyId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.onModuleDestroy();
  });

  it("falls back to the company's global tier when no override exists", async () => {
    const tier = await resolveEffectiveTier(prisma, companyId, zoneId, new Date());
    expect(tier).toBe('SILVER');
  });

  it('applies an ACTIVE unexpired override for the (company, zone) pair', async () => {
    const now = new Date();
    // tier-override-fixture-guard-ok: `now` is a live new Date(), not a frozen constant — the
    // created_at default and this expiresAt stay in sync as real time advances (#183 R5).
    await prisma.companyTierOverride.create({
      data: {
        companyId,
        zoneId,
        tier: 'PLATINUM',
        reason: 'Single active override for the resolver test',
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        status: 'ACTIVE',
      },
    });
    const tier = await resolveEffectiveTier(prisma, companyId, zoneId, now);
    expect(tier).toBe('PLATINUM');
  });

  it('does not apply an override scoped to a different zone', async () => {
    const tier = await resolveEffectiveTier(prisma, companyId, otherZoneId, new Date());
    expect(tier).toBe('SILVER');
  });

  it('under stacking, the newest override wins regardless of insertion order (Q-A, confirmed newest-wins)', async () => {
    const now = new Date();
    await prisma.companyTierOverride.deleteMany({ where: { companyId, zoneId } });
    const older = await prisma.companyTierOverride.create({
      data: {
        companyId,
        zoneId,
        tier: 'GOLD',
        reason: 'Older stacked override — must lose to the newer one',
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        status: 'ACTIVE',
        createdAt: new Date(now.getTime() - 60 * 60 * 1000),
      },
    });
    // tier-override-fixture-guard-ok: `now` is a live new Date(), not a frozen constant (#183 R5).
    await prisma.companyTierOverride.create({
      data: {
        companyId,
        zoneId,
        tier: 'PLATINUM',
        reason: 'Newer stacked override — must win',
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        status: 'ACTIVE',
      },
    });

    const tier = await resolveEffectiveTier(prisma, companyId, zoneId, now);
    expect(tier).toBe('PLATINUM');
    expect(older.tier).toBe('GOLD'); // sanity — the older row itself is untouched
  });

  it('sweep-lag pin: an ACTIVE row past its expiresAt does NOT apply, even though status has not been swept yet', async () => {
    await prisma.companyTierOverride.deleteMany({ where: { companyId, zoneId } });
    const createdAt = new Date();
    // expiresAt must be > createdAt to satisfy the DB CHECK (an override can never be created
    // already-expired); the sweep-lag scenario is simulated by resolving at a LATER `now`, not by
    // backdating expiresAt below creation time.
    // tier-override-fixture-guard-ok: `createdAt` here is a live new Date(), not a frozen constant
    // (#183 R5) — this is the local var used to compute expiresAt, the column itself takes the DB
    // default which resolves to the same real instant.
    await prisma.companyTierOverride.create({
      data: {
        companyId,
        zoneId,
        tier: 'PLATINUM',
        reason: 'Expired override whose status the sweep has not flipped yet',
        expiresAt: new Date(createdAt.getTime() + 1000),
        status: 'ACTIVE',
      },
    });

    const resolveAfterExpiry = new Date(createdAt.getTime() + 60 * 60 * 1000);
    const tier = await resolveEffectiveTier(prisma, companyId, zoneId, resolveAfterExpiry);
    expect(tier).toBe('SILVER');
  });

  it('ignores a CANCELLED override even if its expiresAt has not passed', async () => {
    await prisma.companyTierOverride.deleteMany({ where: { companyId, zoneId } });
    const now = new Date();
    // tier-override-fixture-guard-ok: `now` is a live new Date(), not a frozen constant (#183 R5).
    await prisma.companyTierOverride.create({
      data: {
        companyId,
        zoneId,
        tier: 'PLATINUM',
        reason: 'Cancelled override must not apply',
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        status: 'CANCELLED',
        cancelledAt: now,
      },
    });

    const tier = await resolveEffectiveTier(prisma, companyId, zoneId, now);
    expect(tier).toBe('SILVER');
  });
});
