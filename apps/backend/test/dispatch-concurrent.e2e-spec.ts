import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';

/**
 * Issue 100 AC#5/#6 — two concurrent dispatches of the same zone produce exactly ONE Day Plan. The
 * per-zone advisory lock (`pg_try_advisory_xact_lock`) serializes them; the loser degrades to a clean
 * no-op instead of a 500 (and the partial uniques are the durable backstop if the lock is ever
 * bypassed). Neither call throws.
 */
const NS = Date.now();

describe('Issue 100 — concurrent dispatchForZone yields one plan (advisory lock)', () => {
  let prisma: PrismaService;
  let rec: RecommenderService;
  let dispatch: BatchAssignmentService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let seId: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  const NOW = new Date('2026-06-21T06:00:00Z');

  const makeTicket = async (gpsAgeMin: number): Promise<string> => {
    const deviceId = String(9_510_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: { deviceId, isInactive: true, slaBucket: 'CRITICAL', eligibleForUptime: true, hasOpenFailureCycle: true, latestGpsDatetime: new Date(NOW.getTime() - gpsAgeMin * 60_000), plantId, companyId, computedAt: NOW },
    });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
    const ticket = await prisma.ticket.create({
      data: { workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: cycle.cycleId, deviceId, plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: NOW },
    });
    ticketIds.push(ticket.ticketId);
    return ticket.ticketId;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    rec = new RecommenderService(prisma, new CandidateSelectionService(prisma));
    dispatch = new BatchAssignmentService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-conc-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-conc-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-conc-' + NS, zoneId } })).plantId;
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({ data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@conc.test`, zoneId } });
    userIds.push(u.userId);
    seId = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: seId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
    await prisma.seCoverage.create({ data: { seId, plantId, coverageType: 'DEDICATED' } });

    await makeTicket(120);
    await makeTicket(60);
    await rec.runForZone(zoneId, { now: NOW });
  });

  afterAll(async () => {
    const schedules = await prisma.workSchedule.findMany({ where: { zoneId }, select: { scheduleId: true } });
    const batches = await prisma.plantBatchAssignment.findMany({ where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } }, select: { batchId: true } });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.workSchedule.deleteMany({ where: { zoneId } });
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seCoverage.deleteMany({ where: { plantId } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('two Promise.all dispatches → one ACTIVE schedule, one set of batch tickets, neither throws', async () => {
    const [a, b] = await Promise.all([
      dispatch.dispatchForZone(zoneId, { dateFrom: NOW, dateTo: NOW, now: NOW }),
      dispatch.dispatchForZone(zoneId, { dateFrom: NOW, dateTo: NOW, now: NOW }),
    ]);

    // Exactly one call did the work; the other was a clean no-op.
    expect(a.tickets + b.tickets).toBe(2);
    expect(Math.min(a.tickets, b.tickets)).toBe(0);

    const schedules = await prisma.workSchedule.findMany({ where: { zoneId, seId } });
    expect(schedules).toHaveLength(1);

    const batches = await prisma.plantBatchAssignment.findMany({ where: { scheduleId: schedules[0].scheduleId } });
    const rows = await prisma.batchAssignmentTicket.findMany({ where: { batchId: { in: batches.map((x) => x.batchId) } } });
    expect(rows).toHaveLength(2);
  });
});
