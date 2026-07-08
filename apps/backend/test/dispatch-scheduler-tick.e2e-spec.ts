import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { DispatchRunService } from '../src/scheduling/dispatch-run.service';
import { DispatchSchedulerService } from '../src/scheduling/dispatch-scheduler.service';

/**
 * Issue 113 AC#1 (end-to-end) — with the scheduler enabled, a single dispatch TICK (no HTTP call)
 * takes an OPEN/UNASSIGNED ticket all the way to a dispatched Day Plan. And AC#2: disabled ⇒ the tick
 * is a dormant no-op that leaves the ticket untouched.
 */
const NS = Date.now();
const NOW = new Date('2026-06-21T06:00:00Z');

describe('Issue 113 — a scheduler tick dispatches without an HTTP call', () => {
  let prisma: PrismaService;
  let run: DispatchRunService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let seId: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];

  const makeTicket = async (): Promise<string> => {
    const deviceId = String(9_550_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: { deviceId, isInactive: true, slaBucket: 'CRITICAL', eligibleForUptime: true, hasOpenFailureCycle: true, latestGpsDatetime: new Date(NOW.getTime() - 120 * 60_000), plantId, companyId, computedAt: NOW },
    });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
    const t = await prisma.ticket.create({
      data: { workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: cycle.cycleId, deviceId, plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: NOW },
    });
    ticketIds.push(t.ticketId);
    return t.ticketId;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    run = new DispatchRunService(prisma, new RecommenderService(prisma, new CandidateSelectionService(prisma)), new BatchAssignmentService(prisma));

    zoneId = (await prisma.zone.create({ data: { name: 'Z-tick-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-tick-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-tick-' + NS, zoneId } })).plantId;
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({ data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@tick.test`, zoneId } });
    userIds.push(u.userId);
    seId = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: seId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
    await prisma.seCoverage.create({ data: { seId, plantId, coverageType: 'DEDICATED' } });
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

  it('dormant tick (master switch off) leaves the ticket UNASSIGNED', async () => {
    const ticketId = await makeTicket();
    const off = new DispatchSchedulerService(run, { enabled: false });
    expect(await off.dispatchTick(NOW)).toEqual({ ran: false, reason: 'DISABLED' });
    expect((await prisma.ticket.findUniqueOrThrow({ where: { ticketId } })).assignmentState).toBe('UNASSIGNED');
  });

  it('an enabled tick dispatches the ticket to a Day Plan', async () => {
    const enabled = new DispatchSchedulerService(run, { enabled: true });
    expect(await enabled.dispatchTick(NOW)).toEqual({ ran: true });

    const schedules = await prisma.workSchedule.findMany({ where: { zoneId, seId } });
    expect(schedules).toHaveLength(1);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { ticketId: ticketIds[0] } })).assignmentState).toBe('FORMALLY_ASSIGNED');
  });
});
