import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { ZmScheduleQueryService } from '../src/scheduling/zm-schedule-query.service';

/**
 * Issue 13a, slice 1 — ZM monitoring reads (AC#1/#2). listSchedules gives per-SE rows (batch count,
 * date range, AUTO_ASSIGNED/OVERRIDDEN status) zone-scoped for a ZM; getScheduleDetail gives the
 * ordered stops plus the per-ticket "Why suggested?" Recommender reasoning. Monitoring only — no
 * approval/countdown semantics.
 */
const NS = Date.now();

describe('Issue 13a slice 1 — ZmScheduleQueryService', () => {
  let prisma: PrismaService;
  let rec: RecommenderService;
  let dispatch: BatchAssignmentService;
  let zm: ZmScheduleQueryService;

  let zoneId: bigint;
  let otherZoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let se: string;
  const userIds: string[] = [];
  const deviceIds: bigint[] = [];
  const ticketIds: string[] = [];
  const NOW = new Date('2026-06-21T06:00:00Z');

  const makeTicket = async (plant: bigint, gpsAgeMin: number): Promise<string> => {
    const deviceId = BigInt(10_100_000_000 + (NS % 100_000) * 10 + deviceIds.length);
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
    dispatch = new BatchAssignmentService(prisma);
    zm = new ZmScheduleQueryService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-zm-' + NS } })).zoneId;
    otherZoneId = (await prisma.zone.create({ data: { name: 'Z-zm-other-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-zm-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-zm-' + NS, zoneId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@zm.test`, zoneId },
    });
    userIds.push(u.userId);
    se = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
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
    await prisma.zone.deleteMany({ where: { zoneId: { in: [zoneId, otherZoneId] } } });
    await prisma.onModuleDestroy();
  });

  it('lists per-SE schedule rows for the ZM zone with batch/ticket counts and status', async () => {
    const rows = await zm.listSchedules({ role: 'ZONAL_MANAGER', zoneId: Number(zoneId) });
    const mine = rows.filter((r) => r.seId === se);
    expect(mine).toHaveLength(1);
    expect(mine[0].status).toBe('ACTIVE');
    expect(mine[0].batchCount).toBe(1);
    expect(mine[0].ticketCount).toBe(2);
  });

  it('excludes schedules from other zones for a zone-scoped ZM', async () => {
    const rows = await zm.listSchedules({ role: 'ZONAL_MANAGER', zoneId: Number(otherZoneId) });
    expect(rows.some((r) => r.seId === se)).toBe(false);
  });

  it('returns ordered stops with per-ticket Recommender reasoning in the detail view', async () => {
    const detail = await zm.getScheduleDetail(se, { role: 'ZONAL_MANAGER', zoneId: Number(zoneId) });
    expect(detail).not.toBeNull();
    expect(detail!.stops).toHaveLength(1);
    const stop = detail!.stops[0];
    expect(stop.deviceCount).toBe(2);
    const reasoning = stop.tickets[0].reasoning;
    expect(reasoning).not.toBeNull();
    expect(reasoning!.companyTier).toBe('GOLD');
    expect(reasoning!.deviceBucket).toBe('CRITICAL');
    expect(reasoning!.companyPriorityRank).toBe('B');
    expect(typeof reasoning!.clusterMultiplier).toBe('number');
  });
});
