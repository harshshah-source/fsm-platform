import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { LoggingDayPlanNotifier } from '../src/scheduling/day-plan-notifier';
import { OverrideService } from '../src/scheduling/override.service';

/**
 * Issue 13a, slice 4 — SWAP_SE / REASSIGN / SPLIT_BATCH (AC#3/#4). The SE-moving overrides: swap a
 * whole batch to another SE, reassign a single ticket, or split a subset of a batch's tickets to
 * another SE. The moved work lands under the target SE's (ZM_MANUAL) schedule so their Day Plan
 * re-points; the source batch + schedule flip OVERRIDDEN; tickets stay FORMALLY_ASSIGNED.
 */
const NS = Date.now();

describe('Issue 13a slice 4 — SWAP_SE / REASSIGN / SPLIT_BATCH', () => {
  let prisma: PrismaService;
  let rec: RecommenderService;
  let dispatch: BatchAssignmentService;
  let override: OverrideService;

  let zoneId: bigint;
  let companyId: bigint;
  let pSwap: bigint;
  let pReassign: bigint;
  let pSplit: bigint;
  let se1: string;
  let se2: string;
  let batchSwap: bigint;
  let batchReassign: bigint;
  let batchSplit: bigint;
  let reassignTicket: string;
  let splitMoved: string;
  let splitKept: string;
  const userIds: string[] = [];
  const deviceIds: bigint[] = [];
  const ticketIds: string[] = [];
  const ZM = { userId: '11111111-1111-1111-1111-111111111111', role: 'ZONAL_MANAGER', actedAsRole: null };
  const NOW = new Date('2026-06-21T06:00:00Z');
  const scope = { role: 'ZONAL_MANAGER', zoneId: 0 };

  const makeTicket = async (plant: bigint, gpsAgeMin: number): Promise<string> => {
    const deviceId = BigInt(10_400_000_000 + (NS % 100_000) * 10 + deviceIds.length);
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

  const makeSe = async (coverage: 'DEDICATED' | 'MULTI_PLANT'): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@ss.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({ data: { engineerId: u.userId, coverageType: coverage, zoneId, dailyCapacity: 20 } });
    return u.userId;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    rec = new RecommenderService(prisma, new CandidateSelectionService(prisma));
    dispatch = new BatchAssignmentService(prisma);
    override = new OverrideService(prisma, new AuditService(prisma), new LoggingDayPlanNotifier());

    zoneId = (await prisma.zone.create({ data: { name: 'Z-ss-' + NS } })).zoneId;
    scope.zoneId = Number(zoneId);
    companyId = (
      await prisma.company.create({ data: { name: 'Co-ss-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    pSwap = (await prisma.plant.create({ data: { name: 'P-sw-' + NS, zoneId } })).plantId;
    pReassign = (await prisma.plant.create({ data: { name: 'P-re-' + NS, zoneId } })).plantId;
    pSplit = (await prisma.plant.create({ data: { name: 'P-sp-' + NS, zoneId } })).plantId;

    se1 = await makeSe('MULTI_PLANT');
    se2 = await makeSe('MULTI_PLANT');
    for (const p of [pSwap, pReassign, pSplit]) {
      await prisma.seCoverage.create({ data: { seId: se1, plantId: p, coverageType: 'MULTI_PLANT' } });
    }

    await makeTicket(pSwap, 100);
    reassignTicket = await makeTicket(pReassign, 100);
    splitMoved = await makeTicket(pSplit, 200); // older → sort 1
    splitKept = await makeTicket(pSplit, 50);

    await rec.runForZone(zoneId, { now: NOW });
    await dispatch.dispatchForZone(zoneId, { dateFrom: NOW, dateTo: NOW, now: NOW });

    batchSwap = (await prisma.plantBatchAssignment.findFirstOrThrow({ where: { plantId: pSwap } })).batchId;
    batchReassign = (await prisma.plantBatchAssignment.findFirstOrThrow({ where: { plantId: pReassign } })).batchId;
    batchSplit = (await prisma.plantBatchAssignment.findFirstOrThrow({ where: { plantId: pSplit } })).batchId;

    await override.override(batchSwap, { action: 'SWAP_SE', newSeId: se2, reasonCode: 'SE1_SICK' }, scope, ZM);
    await override.override(
      batchReassign,
      { action: 'REASSIGN', ticketId: reassignTicket, newSeId: se2, reasonCode: 'CLOSER_SE' },
      scope,
      ZM,
    );
    await override.override(
      batchSplit,
      { action: 'SPLIT_BATCH', ticketIds: [splitMoved], newSeId: se2, reasonCode: 'LOAD_BALANCE' },
      scope,
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
    await prisma.auditLog.deleteMany({
      where: { entityType: 'plant_batch_assignment', entityId: { in: [batchSwap, batchReassign, batchSplit].map(String) } },
    });
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seCoverage.deleteMany({ where: { seId: se1 } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [pSwap, pReassign, pSplit] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('SWAP_SE moves the whole batch under the target SE and flips OVERRIDDEN', async () => {
    const batch = await prisma.plantBatchAssignment.findUniqueOrThrow({ where: { batchId: batchSwap }, include: { schedule: true } });
    expect(batch.seId).toBe(se2);
    expect(batch.schedule.seId).toBe(se2);
    expect(batch.status).toBe('OVERRIDDEN');
  });

  it('REASSIGN moves one ticket to a batch under the target SE; ticket stays assigned', async () => {
    const oldRow = await prisma.batchAssignmentTicket.findFirstOrThrow({ where: { batchId: batchReassign, ticketId: reassignTicket } });
    expect(oldRow.removedAt).not.toBeNull();
    const newRows = await prisma.batchAssignmentTicket.findMany({
      where: { ticketId: reassignTicket, removedAt: null },
      include: { batch: true },
    });
    expect(newRows).toHaveLength(1);
    expect(newRows[0].batch.seId).toBe(se2);
    expect(newRows[0].batch.plantId).toBe(pReassign);
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: reassignTicket } });
    expect(ticket.assignmentState).toBe('FORMALLY_ASSIGNED');
  });

  it('SPLIT_BATCH moves the listed tickets to the target SE and keeps the rest', async () => {
    const movedActive = await prisma.batchAssignmentTicket.findFirstOrThrow({ where: { ticketId: splitMoved, removedAt: null }, include: { batch: true } });
    expect(movedActive.batch.seId).toBe(se2);
    expect(movedActive.batch.plantId).toBe(pSplit);
    const keptRow = await prisma.batchAssignmentTicket.findFirstOrThrow({ where: { batchId: batchSplit, ticketId: splitKept } });
    expect(keptRow.removedAt).toBeNull();
    const source = await prisma.plantBatchAssignment.findUniqueOrThrow({ where: { batchId: batchSplit } });
    expect(source.status).toBe('OVERRIDDEN');
  });
});
