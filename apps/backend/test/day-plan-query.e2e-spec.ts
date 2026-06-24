import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { DayPlanQueryService } from '../src/scheduling/day-plan-query.service';

/**
 * Issue 11, slice 5 — the SE Day Plan read model (AC#5). getDayPlan(seId) returns the dispatched
 * plan as ordered, plant-clustered stops (stop sequence, plant name, device count per stop, the
 * stop's tickets in sort order); a fresh SE with no dispatched schedule gets the empty-state
 * ("plan being prepared"). Integration-style: builds a real dispatched plan first.
 */
const NS = Date.now();

describe('Issue 11 slice 5 — DayPlanQueryService.getDayPlan', () => {
  let prisma: PrismaService;
  let rec: RecommenderService;
  let dispatch: BatchAssignmentService;
  let dayPlan: DayPlanQueryService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let plantName: string;
  let se: string;
  const userIds: string[] = [];
  const deviceIds: bigint[] = [];
  const ticketIds: string[] = [];
  const NOW = new Date('2026-06-21T06:00:00Z');

  const makeTicket = async (plant: bigint, gpsAgeMin: number): Promise<string> => {
    const deviceId = BigInt(9_700_000_000 + (NS % 100_000) * 10 + deviceIds.length);
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

  const makeSe = async (): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@dayplan.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({ data: { engineerId: u.userId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
    return u.userId;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    rec = new RecommenderService(prisma, new CandidateSelectionService(prisma));
    dispatch = new BatchAssignmentService(prisma);
    dayPlan = new DayPlanQueryService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-dp-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-dp-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantName = 'P-dp-' + NS;
    plantId = (await prisma.plant.create({ data: { name: plantName, zoneId } })).plantId;

    se = await makeSe();
    await prisma.seCoverage.create({ data: { seId: se, plantId, coverageType: 'DEDICATED' } });

    await makeTicket(plantId, 180);
    await makeTicket(plantId, 60);

    await rec.runForZone(zoneId, { now: NOW });
    await dispatch.dispatchForZone(zoneId, { dateFrom: NOW, dateTo: NOW, now: NOW });
  });

  afterAll(async () => {
    const schedules = await prisma.workSchedule.findMany({ where: { zoneId }, select: { scheduleId: true } });
    const batches = await prisma.plantBatchAssignment.findMany({
      where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } },
      select: { batchId: true },
    });
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

  it('returns the dispatched plan as ordered, plant-clustered stops with device counts', async () => {
    const view = await dayPlan.getDayPlan(se);
    expect(view.dispatched).toBe(true);
    expect(view.stops).toHaveLength(1);
    const stop = view.stops[0];
    expect(stop.stopSequence).toBe(1);
    expect(stop.plantId).toBe(String(plantId));
    expect(stop.plantName).toBe(plantName);
    expect(stop.deviceCount).toBe(2);
    expect(stop.tickets.map((t) => t.ticketId).sort()).toEqual([...ticketIds].sort());
  });

  it('returns the empty-state for an SE with no dispatched schedule', async () => {
    const fresh = await makeSe();
    const view = await dayPlan.getDayPlan(fresh);
    expect(view.dispatched).toBe(false);
    expect(view.stops).toEqual([]);
  });
});
