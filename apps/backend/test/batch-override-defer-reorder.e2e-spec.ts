import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { LoggingDayPlanNotifier } from '../src/scheduling/day-plan-notifier';
import { OverrideService } from '../src/scheduling/override.service';

/**
 * Issue 13a, slice 3 — DEFER_TICKET + REORDER (AC#3). Defer stamps a ticket's deferred-to date and
 * flips the batch OVERRIDDEN; reorder re-sequences a Multi-Plant SE's plant stops (this batch moves to
 * the target stop_sequence, the rest renumber). Both audit + push like every override.
 */
const NS = Date.now();

describe('Issue 13a slice 3 — DEFER_TICKET + REORDER', () => {
  let prisma: PrismaService;
  let rec: RecommenderService;
  let dispatch: BatchAssignmentService;
  let override: OverrideService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantA: bigint; // older lead ticket → stop 1 at dispatch
  let plantB: bigint;
  let se: string;
  let batchA: bigint;
  let batchB: bigint;
  const userIds: string[] = [];
  const deviceIds: bigint[] = [];
  const ticketIds: string[] = [];
  let ticketA: string;
  const ZM = { userId: '11111111-1111-1111-1111-111111111111', role: 'ZONAL_MANAGER', actedAsRole: null };
  const NOW = new Date('2026-06-21T06:00:00Z');

  const makeTicket = async (plant: bigint, gpsAgeMin: number): Promise<string> => {
    const deviceId = BigInt(10_300_000_000 + (NS % 100_000) * 10 + deviceIds.length);
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
    override = new OverrideService(prisma, new AuditService(prisma), new LoggingDayPlanNotifier());

    zoneId = (await prisma.zone.create({ data: { name: 'Z-dr-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-dr-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantA = (await prisma.plant.create({ data: { name: 'P-A-' + NS, zoneId } })).plantId;
    plantB = (await prisma.plant.create({ data: { name: 'P-B-' + NS, zoneId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@dr.test`, zoneId },
    });
    userIds.push(u.userId);
    se = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'MULTI_PLANT', zoneId, dailyCapacity: 10 } });
    await prisma.seCoverage.create({ data: { seId: se, plantId: plantA, coverageType: 'MULTI_PLANT' } });
    await prisma.seCoverage.create({ data: { seId: se, plantId: plantB, coverageType: 'MULTI_PLANT' } });

    ticketA = await makeTicket(plantA, 180); // older → stop 1
    await makeTicket(plantB, 60); // newer → stop 2

    await rec.runForZone(zoneId, { now: NOW });
    await dispatch.dispatchForZone(zoneId, { dateFrom: NOW, dateTo: NOW, now: NOW });

    batchA = (await prisma.plantBatchAssignment.findFirstOrThrow({ where: { plantId: plantA } })).batchId;
    batchB = (await prisma.plantBatchAssignment.findFirstOrThrow({ where: { plantId: plantB } })).batchId;

    await override.override(
      batchA,
      { action: 'DEFER_TICKET', ticketId: ticketA, deferredToDate: '2026-06-25', reasonCode: 'PARTS_ETA' },
      { role: 'ZONAL_MANAGER', zoneId: Number(zoneId) },
      ZM,
    );
    await override.override(
      batchB,
      { action: 'REORDER', stopSequence: 1, reasonCode: 'ROUTE_OPT' },
      { role: 'ZONAL_MANAGER', zoneId: Number(zoneId) },
      ZM,
    );
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
    await prisma.auditLog.deleteMany({ where: { entityType: 'plant_batch_assignment', entityId: { in: [String(batchA), String(batchB)] } } });
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seCoverage.deleteMany({ where: { seId: se } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [plantA, plantB] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('DEFER_TICKET stamps the deferred-to date and flips the batch OVERRIDDEN', async () => {
    const bat = await prisma.batchAssignmentTicket.findFirstOrThrow({ where: { batchId: batchA, ticketId: ticketA } });
    expect(bat.deferredToDate?.toISOString().slice(0, 10)).toBe('2026-06-25');
    const batch = await prisma.plantBatchAssignment.findUniqueOrThrow({ where: { batchId: batchA } });
    expect(batch.status).toBe('OVERRIDDEN');
  });

  it('REORDER moves the batch to the target stop and renumbers the rest', async () => {
    const b = await prisma.plantBatchAssignment.findUniqueOrThrow({ where: { batchId: batchB } });
    const a = await prisma.plantBatchAssignment.findUniqueOrThrow({ where: { batchId: batchA } });
    expect(b.stopSequence).toBe(1);
    expect(a.stopSequence).toBe(2);
    expect(b.status).toBe('OVERRIDDEN');
  });
});
