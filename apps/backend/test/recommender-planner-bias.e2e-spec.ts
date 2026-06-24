import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';

/**
 * Issue 14a, slice 3 — SE Planner soft bias into the batch run (AC#3/#4, ADR-0022). When the planner
 * names an SE to visit a plant on the run date, the Recommender prefers that SE among the eligible
 * candidates for that plant — overriding strict precedence. Soft: if the planned SE is not an eligible
 * candidate, selection falls back to precedence (Dedicated→Multi→Floating).
 */
const NS = Date.now();

describe('Issue 14a slice 3 — recommender planner bias', () => {
  let prisma: PrismaService;
  let rec: RecommenderService;

  let zoneId: bigint;
  let companyId: bigint;
  let pBias: bigint;
  let pFallback: bigint;
  let dedBias: string; // dedicated on pBias — precedence-first
  let multiBias: string; // multi on pBias — planner-named
  let dedFallback: string; // dedicated on pFallback
  const userIds: string[] = [];
  const deviceIds: bigint[] = [];
  const ticketIds: string[] = [];
  let biasTicket: string;
  let fallbackTicket: string;
  const NOW = new Date('2026-06-21T06:00:00Z');
  const DAY = new Date('2026-06-21');

  const makeSe = async (coverage: 'DEDICATED' | 'MULTI_PLANT'): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@pb.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({ data: { engineerId: u.userId, coverageType: coverage, zoneId, dailyCapacity: 10 } });
    return u.userId;
  };

  const makeTicket = async (plant: bigint): Promise<string> => {
    const deviceId = BigInt(10_700_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        hasOpenFailureCycle: true,
        latestGpsDatetime: new Date(NOW.getTime() - 120 * 60_000),
        plantId: plant,
        companyId,
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
        companyId,
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

    zoneId = (await prisma.zone.create({ data: { name: 'Z-pb-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-pb-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    pBias = (await prisma.plant.create({ data: { name: 'P-bias-' + NS, zoneId } })).plantId;
    pFallback = (await prisma.plant.create({ data: { name: 'P-fb-' + NS, zoneId } })).plantId;

    dedBias = await makeSe('DEDICATED');
    multiBias = await makeSe('MULTI_PLANT');
    dedFallback = await makeSe('DEDICATED');
    await prisma.seCoverage.create({ data: { seId: dedBias, plantId: pBias, coverageType: 'DEDICATED' } });
    await prisma.seCoverage.create({ data: { seId: multiBias, plantId: pBias, coverageType: 'MULTI_PLANT' } });
    await prisma.seCoverage.create({ data: { seId: dedFallback, plantId: pFallback, coverageType: 'DEDICATED' } });

    // Planner: multiBias visits pBias today (eligible → should win), and pFallback today (not a
    // candidate there → ignored, precedence falls back to dedFallback).
    await prisma.sePlanner.create({ data: { seId: multiBias, plantId: pBias, plannedDate: DAY } });
    await prisma.sePlanner.create({ data: { seId: multiBias, plantId: pFallback, plannedDate: DAY } });

    biasTicket = await makeTicket(pBias);
    fallbackTicket = await makeTicket(pFallback);

    await rec.runForZone(zoneId, { now: NOW });
  });

  afterAll(async () => {
    await prisma.sePlanner.deleteMany({ where: { seId: { in: [multiBias] } } });
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seCoverage.deleteMany({ where: { plantId: { in: [pBias, pFallback] } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [pBias, pFallback] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  const recFor = (ticketId: string) =>
    prisma.recommendation.findFirstOrThrow({ where: { ticketId }, orderBy: { recommendationId: 'desc' } });

  it('prefers the planner-named SE over strict precedence when eligible', async () => {
    const r = await recFor(biasTicket);
    expect(r.seId).toBe(multiBias); // planner bias beat the dedicated SE
  });

  it('falls back to precedence when the planned SE is not an eligible candidate', async () => {
    const r = await recFor(fallbackTicket);
    expect(r.seId).toBe(dedFallback); // multiBias does not cover pFallback → ignored
  });
});
