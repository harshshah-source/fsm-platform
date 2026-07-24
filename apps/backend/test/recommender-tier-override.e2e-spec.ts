import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';

/**
 * Issue 157, Slice 3 — AC-4: a ZM's zone-scoped PLATINUM override provably reorders that zone's
 * dispatch (the canonical-sort seam, asserted at the `runForZone` boundary), is stamped in
 * `scoreBreakdown` with the overriding row's id, leaves the OTHER zone's dispatch untouched, and
 * never writes to the OH-owned global `company_master.company_tier`.
 */
const NS = Date.now();

describe('Issue 157 Slice 3 — effective-tier engine bite (AC-4)', () => {
  let prisma: PrismaService;
  let rec: RecommenderService;
  let zoneA: bigint;
  let zoneB: bigint;
  let companySilver: bigint;
  let companyGold: bigint;
  let plantA: bigint;
  let plantB: bigint;
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  const NOW = new Date('2026-07-23T06:00:00Z');

  const makeTicket = async (plant: bigint, company: bigint): Promise<string> => {
    const deviceId = String(9_400_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        hasOpenFailureCycle: true,
        latestGpsDatetime: NOW,
        plantId: plant,
        companyId: company,
        computedAt: NOW,
      },
    });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        failureCycleId: cycle.cycleId,
        deviceId,
        plantId: plant,
        companyId: company,
        // The creation-time stamp is irrelevant here — runForZone re-derives the effective tier live.
        companyTier: 'GOLD',
        lastStateChangedAt: NOW,
      },
    });
    ticketIds.push(ticket.ticketId);
    return ticket.ticketId;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    rec = new RecommenderService(prisma, new CandidateSelectionService(prisma));

    zoneA = (await prisma.zone.create({ data: { name: 'Z157A-' + NS } })).zoneId;
    zoneB = (await prisma.zone.create({ data: { name: 'Z157B-' + NS } })).zoneId;
    companySilver = (
      await prisma.company.create({ data: { name: 'Co157Silver-' + NS, companyTier: 'SILVER', companyPriorityRank: 'C' } })
    ).companyId;
    companyGold = (
      await prisma.company.create({ data: { name: 'Co157Gold-' + NS, companyTier: 'GOLD', companyPriorityRank: 'C' } })
    ).companyId;
    plantA = (await prisma.plant.create({ data: { name: 'P157A-' + NS, zoneId: zoneA } })).plantId;
    plantB = (await prisma.plant.create({ data: { name: 'P157B-' + NS, zoneId: zoneB } })).plantId;

    await prisma.companyTierOverride.create({
      data: {
        companyId: companySilver,
        zoneId: zoneA,
        tier: 'PLATINUM',
        reason: 'AC-4 fixture — Silver raised to Platinum in zone A only',
        expiresAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
        status: 'ACTIVE',
      },
    });

    // Zone A: Gold's ticket is created FIRST, so absent the override canonical order would still
    // put it ahead of Silver's — proving the override, not creation order, drives the reorder.
    await makeTicket(plantA, companyGold);
    await makeTicket(plantA, companySilver);
    // Zone B: the SAME company, no override there — must resolve to its plain global tier.
    await makeTicket(plantB, companySilver);

    await rec.runForZone(zoneA, { now: NOW });
    await rec.runForZone(zoneB, { now: NOW });
  });

  afterAll(async () => {
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.companyTierOverride.deleteMany({ where: { companyId: companySilver } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [plantA, plantB] } } });
    await prisma.company.deleteMany({ where: { companyId: { in: [companySilver, companyGold] } } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: [zoneA, zoneB] } } });
    await prisma.onModuleDestroy();
  });

  const recFor = (ticketId: string) =>
    prisma.recommendation.findFirstOrThrow({ where: { ticketId }, orderBy: { recommendationId: 'desc' } });

  it("provably reorders zone A's dispatch: Silver (overridden to Platinum) processes ahead of Gold", async () => {
    const goldRec = await recFor(ticketIds[0]);
    const silverRec = await recFor(ticketIds[1]);
    expect(silverRec.companyTier).toBe('PLATINUM');
    expect(goldRec.companyTier).toBe('GOLD');
    expect(silverRec.processingRank!).toBeLessThan(goldRec.processingRank!);
  });

  it('stamps scoreBreakdown with the overriding tier and its overrideId when applied', async () => {
    const silverRec = await recFor(ticketIds[1]);
    const override = await prisma.companyTierOverride.findFirstOrThrow({
      where: { companyId: companySilver, zoneId: zoneA },
    });
    const breakdown = silverRec.scoreBreakdown as Record<string, unknown>;
    expect(breakdown.companyTier).toBe('PLATINUM');
    expect(breakdown.tierOverrideId).toBe(override.id.toString());
  });

  it('leaves the OTHER zone untouched — the same company resolves to its plain global tier there', async () => {
    const zoneBRec = await recFor(ticketIds[2]);
    expect(zoneBRec.companyTier).toBe('SILVER');
    const breakdown = zoneBRec.scoreBreakdown as Record<string, unknown>;
    expect(breakdown.tierOverrideId ?? null).toBeNull();
  });

  it('never writes to the OH-owned global company_master.company_tier', async () => {
    const company = await prisma.company.findUniqueOrThrow({ where: { companyId: companySilver } });
    expect(company.companyTier).toBe('SILVER');
  });
});
