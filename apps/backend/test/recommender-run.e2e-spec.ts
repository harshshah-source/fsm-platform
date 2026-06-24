import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';

/**
 * Issue 10, slice 6 — the Recommender orchestrator (AC#1 fallback, AC#5 reasoning, AC#6 persist).
 * Per zone: collect OPEN unassigned TROUBLESHOOT tickets, canonical-sort them, and for each pick the
 * highest-precedence eligible SE (Dedicated→Multi-Plant→Floating, falling back when the primary is at
 * Daily Capacity), score it (cluster multiplier on additional same-plant tickets), and persist a
 * `recommendations` row with the reasoning breakdown. Tickets with no eligible SE persist as
 * UNASSIGNABLE — never silently dropped.
 */
const NS = Date.now();

describe('Issue 10 slice 6 — RecommenderService.runForZone', () => {
  let prisma: PrismaService;
  let rec: RecommenderService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let plantNoSe: bigint;
  let dedicated: string;
  let multi: string;
  const userIds: string[] = [];
  const deviceIds: bigint[] = [];
  const ticketIds: string[] = [];
  const NOW = new Date('2026-06-21T06:00:00Z');

  const makeSe = async (coverageType: 'DEDICATED' | 'MULTI_PLANT', capacity: number): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@rec.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({
      data: { engineerId: u.userId, coverageType, zoneId, dailyCapacity: capacity },
    });
    return u.userId;
  };

  /** Seed an inactive device + OPEN TROUBLESHOOT ticket at a plant; returns the ticketId. */
  const makeTicket = async (plant: bigint, gpsAgeMin: number): Promise<string> => {
    const deviceId = BigInt(9_300_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        hasOpenFailureCycle: true,
        latestGpsDatetime: new Date(NOW.getTime() - gpsAgeMin * 60_000),
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

    // Deterministic weights + multiplier (decoupled from whatever the shared DB has seeded).
    for (const [component, weight] of [
      ['company_priority_rank', 0.4],
      ['dispatch_urgency', 0.3],
      ['repeat_failure_penalty', 0.2],
      ['distance', 0.1],
    ] as const) {
      await prisma.priorityRuleConfig.upsert({
        where: { weightSetRef_component: { weightSetRef: 'v1', component } },
        create: { weightSetRef: 'v1', component, weight, active: true },
        update: { weight, active: true },
      });
    }
    await prisma.systemSetting.upsert({
      where: { key: 'plant_cluster_multiplier' },
      create: { key: 'plant_cluster_multiplier', value: 1.5, description: 'test' },
      update: { value: 1.5 },
    });

    zoneId = (await prisma.zone.create({ data: { name: 'Z-rec-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-rec-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-rec-' + NS, zoneId } })).plantId;
    plantNoSe = (await prisma.plant.create({ data: { name: 'P-nose-' + NS, zoneId } })).plantId;

    dedicated = await makeSe('DEDICATED', 1); // capacity 1 → forces fallback on the 2nd ticket
    multi = await makeSe('MULTI_PLANT', 5);
    await prisma.seCoverage.create({ data: { seId: dedicated, plantId, coverageType: 'DEDICATED' } });
    await prisma.seCoverage.create({ data: { seId: multi, plantId, coverageType: 'MULTI_PLANT' } });

    // Two tickets at the SE-covered plant (older first), one at the SE-less plant.
    await makeTicket(plantId, 120);
    await makeTicket(plantId, 60);
    await makeTicket(plantNoSe, 90);

    await rec.runForZone(zoneId, { now: NOW });
  });

  afterAll(async () => {
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seCoverage.deleteMany({ where: { plantId } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [plantId, plantNoSe] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  const recFor = (ticketId: string) =>
    prisma.recommendation.findFirstOrThrow({ where: { ticketId }, orderBy: { recommendationId: 'desc' } });

  it('persists a recommendation with the reasoning breakdown for the seed ticket', async () => {
    const r = await recFor(ticketIds[0]);
    expect(r.seId).toBe(dedicated);
    expect(r.companyTier).toBe('GOLD');
    expect(r.deviceBucket).toBe('CRITICAL');
    expect(r.status).toBe('SUGGESTED');
    expect(r.path).toBe('MORNING_BATCH');
    expect(r.processingRank).not.toBeNull();
    const b = r.scoreBreakdown as Record<string, unknown>;
    expect(b.weightSetRef).toBe('v1');
    expect(b.clusterMultiplier).toBe(1); // first ticket at the plant = cluster seed
  });

  it('falls back Dedicated→Multi-Plant when the dedicated SE is at capacity, with a cluster boost', async () => {
    const r = await recFor(ticketIds[1]);
    expect(r.seId).toBe(multi); // dedicated (capacity 1) was consumed by the seed ticket
    expect((r.scoreBreakdown as Record<string, unknown>).clusterMultiplier).toBe(1.5);
  });

  it('persists an UNASSIGNABLE recommendation when no SE covers the plant', async () => {
    const r = await recFor(ticketIds[2]);
    expect(r.seId).toBeNull();
    expect(r.status).toBe('UNASSIGNABLE');
  });
});
