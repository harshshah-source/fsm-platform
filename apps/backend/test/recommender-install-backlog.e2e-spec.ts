import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';

/**
 * Issue 75 slice 2 — in PREVENTIVE mode the Recommender also picks up the Install backlog (open INSTALL
 * tickets: REQUESTED + UNASSIGNED), processed AFTER all TROUBLESHOOT candidates and scored with the
 * preventive weight set (so older backlog ranks higher). DEFICIT stays TROUBLESHOOT-only. The recommender
 * only suggests — the ZM override path (#13) is the human step, so nothing is double-scheduled here.
 */
const NS = Date.now();
const NOW = new Date('2026-06-27T06:00:00Z');

describe('Issue 75 slice 2 — RecommenderService install backlog', () => {
  let prisma: PrismaService;
  let rec: RecommenderService;

  let prevZone: bigint;
  let defZone: bigint;
  let companyId: bigint;
  let prevPlant: bigint;
  let defPlant: bigint;
  let tsTicket: string;
  let installTicket: string;
  let defInstall: string;
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

    prevZone = (await prisma.zone.create({ data: { name: 'Z-ib-P-' + NS } })).zoneId;
    defZone = (await prisma.zone.create({ data: { name: 'Z-ib-D-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-ib-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    prevPlant = (await prisma.plant.create({ data: { name: 'P-ib-P-' + NS, zoneId: prevZone } })).plantId;
    defPlant = (await prisma.plant.create({ data: { name: 'P-ib-D-' + NS, zoneId: defZone } })).plantId;

    const sePrev = await makeSe(prevZone);
    await prisma.seCoverage.create({ data: { seId: sePrev, plantId: prevPlant, coverageType: 'MULTI_PLANT' } });
    const seDef = await makeSe(defZone);
    await prisma.seCoverage.create({ data: { seId: seDef, plantId: defPlant, coverageType: 'MULTI_PLANT' } });

    // PREVENTIVE zone: a non-eligible inactive troubleshoot candidate (ranks but doesn't trip soft-inactive)
    // + an install backlog ticket (target date 30 days ago).
    tsTicket = await makeTroubleshoot(prevPlant);
    installTicket = await makeInstall(prevPlant, new Date(Date.UTC(2026, 4, 28)));

    // DEFICIT zone: an eligible+inactive device (no ticket) tips the zone into DEFICIT; an install backlog
    // ticket here must be ignored (deficit = troubleshoot-only).
    await makeEligibleInactive(defPlant);
    defInstall = await makeInstall(defPlant, new Date(Date.UTC(2026, 4, 28)));

    await rec.runForZone(prevZone, { now: NOW });
    await rec.runForZone(defZone, { now: NOW });
  });

  async function makeSe(zoneId: bigint): Promise<string> {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({ data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ib-' + tag, email: `ib-${tag}@ib.test`, zoneId } });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({ data: { engineerId: u.userId, coverageType: 'MULTI_PLANT', zoneId, dailyCapacity: 5 } });
    return u.userId;
  }

  async function makeTroubleshoot(plant: bigint): Promise<string> {
    const deviceId = nextDevice();
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({ data: { deviceId, isInactive: true, slaBucket: 'CRITICAL', eligibleForUptime: false, latestGpsDatetime: new Date(NOW.getTime() - 36 * 3_600_000), plantId: plant, companyId, computedAt: NOW } });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
    const t = await prisma.ticket.create({ data: { workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: cycle.cycleId, deviceId, plantId: plant, companyId, companyTier: 'GOLD', lastStateChangedAt: NOW } });
    ticketIds.push(t.ticketId);
    return t.ticketId;
  }

  async function makeInstall(plant: bigint, targetDate: Date): Promise<string> {
    const deviceId = nextDevice();
    await prisma.device.create({ data: { deviceId } });
    const t = await prisma.ticket.create({
      data: { workType: 'INSTALL', status: 'REQUESTED', deviceId, plantId: plant, companyId, companyTier: 'GOLD', installTargetDate: targetDate, lastStateChangedAt: NOW },
    });
    ticketIds.push(t.ticketId);
    return t.ticketId;
  }

  async function makeEligibleInactive(plant: bigint): Promise<void> {
    const deviceId = nextDevice();
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({ data: { deviceId, isInactive: true, eligibleForUptime: true, plantId: plant, companyId, computedAt: NOW } });
  }

  function nextDevice(): bigint {
    const id = BigInt(9_750_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(id);
    return id;
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
    await prisma.plant.deleteMany({ where: { plantId: { in: [prevPlant, defPlant] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: [prevZone, defZone] } } });
    await prisma.onModuleDestroy();
  });

  const recFor = (ticketId: string) => prisma.recommendation.findFirst({ where: { ticketId } });

  it('PREVENTIVE: the install backlog gets a recommendation with a null bucket and the preventive weight set', async () => {
    const r = await recFor(installTicket);
    expect(r).toBeTruthy();
    expect(r!.deviceBucket).toBeNull();
    expect((r!.scoreBreakdown as { weightSetRef: string }).weightSetRef).toBe('v1_preventive');
  });

  it('PREVENTIVE: TROUBLESHOOT is processed before the install backlog', async () => {
    const ts = await recFor(tsTicket);
    const inst = await recFor(installTicket);
    expect(ts!.processingRank!).toBeLessThan(inst!.processingRank!);
  });

  it('DEFICIT: install backlog is ignored (troubleshoot-only)', async () => {
    const r = await recFor(defInstall);
    expect(r).toBeNull();
  });
});
