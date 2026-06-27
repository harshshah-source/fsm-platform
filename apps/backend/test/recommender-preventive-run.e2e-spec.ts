import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';

/**
 * Issue 72 slice 2 — `runForZone` re-prioritises in PREVENTIVE mode. A zone whose Soft Inactive Count is
 * under threshold runs PREVENTIVE; the recommender then uses the `<base>_preventive` weight set so a
 * repeat-offender on an aged device out-scores a fresh, non-repeat ticket (the opposite of DEFICIT, where
 * repeat-failure is a penalty). The candidate devices are NOT eligible-for-uptime, so they rank without
 * tripping the soft-inactive count → the zone stays PREVENTIVE. (DEFICIT scoring is guarded by Issue 10's
 * suite.) Install-backlog inclusion is deferred to a follow-up.
 */
const NS = Date.now();
const NOW = new Date('2026-06-27T06:00:00Z');

describe('Issue 72 slice 2 — RecommenderService preventive re-ranking', () => {
  let prisma: PrismaService;
  let rec: RecommenderService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantA: bigint;
  let plantB: bigint;
  let aTicket: string;
  let bTicket: string;
  const userIds: string[] = [];
  const deviceIds: bigint[] = [];
  const ticketIds: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    rec = new RecommenderService(prisma, new CandidateSelectionService(prisma));

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

    zoneId = (await prisma.zone.create({ data: { name: 'Z-prev-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-prev-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantA = (await prisma.plant.create({ data: { name: 'PA-prev-' + NS, zoneId } })).plantId;
    plantB = (await prisma.plant.create({ data: { name: 'PB-prev-' + NS, zoneId } })).plantId;

    const se = await makeSe();
    await prisma.seCoverage.create({ data: { seId: se, plantId: plantA, coverageType: 'MULTI_PLANT' } });
    await prisma.seCoverage.create({ data: { seId: se, plantId: plantB, coverageType: 'MULTI_PLANT' } });

    // Both candidates: NOT eligible-for-uptime → don't count toward soft-inactive → zone stays PREVENTIVE.
    aTicket = await makeTicket(plantA, 7200, true); // aged 5d, repeat-offender
    bTicket = await makeTicket(plantB, 60, false); // fresh 1h, not repeat

    await rec.runForZone(zoneId, { now: NOW });
  });

  async function makeSe(): Promise<string> {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({ data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'pv-' + tag, email: `pv-${tag}@pv.test`, zoneId } });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({ data: { engineerId: u.userId, coverageType: 'MULTI_PLANT', zoneId, dailyCapacity: 5 } });
    return u.userId;
  }

  async function makeTicket(plant: bigint, gpsAgeMin: number, repeat: boolean): Promise<string> {
    const deviceId = BigInt(9_720_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: { deviceId, isInactive: true, slaBucket: 'CRITICAL', eligibleForUptime: false, hasOpenFailureCycle: true, latestGpsDatetime: new Date(NOW.getTime() - gpsAgeMin * 60_000), plantId: plant, companyId, computedAt: NOW },
    });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW, repeatFailure: repeat } });
    const ticket = await prisma.ticket.create({
      data: { workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: cycle.cycleId, deviceId, plantId: plant, companyId, companyTier: 'GOLD', repeatFailure: repeat, lastStateChangedAt: NOW },
    });
    ticketIds.push(ticket.ticketId);
    return ticket.ticketId;
  }

  afterAll(async () => {
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seCoverage.deleteMany({ where: { seId: { in: userIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [plantA, plantB] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  const recFor = (ticketId: string) => prisma.recommendation.findFirstOrThrow({ where: { ticketId } });

  it('runs the zone in PREVENTIVE mode with the preventive weight set stamped', async () => {
    const r = await recFor(aTicket);
    const bd = r.scoreBreakdown as { mode: string; weightSetRef: string };
    expect(bd.mode).toBe('PREVENTIVE');
    expect(bd.weightSetRef).toBe('v1_preventive');
  });

  it('a repeat-offender on an aged device out-scores a fresh, non-repeat ticket', async () => {
    const a = (await recFor(aTicket)).scoreBreakdown as { score: number };
    const b = (await recFor(bTicket)).scoreBreakdown as { score: number };
    expect(a.score).toBeGreaterThan(b.score);
  });
});
