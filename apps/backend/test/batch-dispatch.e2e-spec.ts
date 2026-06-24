import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';

/**
 * Issue 11, slice 2 — the dispatch orchestrator (LLD §13.1 step 6, AC#1/#6). Turns the Recommender's
 * SUGGESTED recommendations into a dispatched Day Plan: one ACTIVE WorkSchedule per SE, one
 * AUTO_ASSIGNED Plant-wise Batch Assignment per plant, and the batch's tickets — directly dispatched,
 * NO approval gate (ADR-0007/0019 superseded). Integration-style: runs the real recommender first.
 */
const NS = Date.now();

describe('Issue 11 slice 2 — BatchAssignmentService.dispatchForZone', () => {
  let prisma: PrismaService;
  let rec: RecommenderService;
  let dispatch: BatchAssignmentService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let dedicated: string;
  const userIds: string[] = [];
  const deviceIds: bigint[] = [];
  const ticketIds: string[] = [];
  const NOW = new Date('2026-06-21T06:00:00Z');

  const makeTicket = async (plant: bigint, gpsAgeMin: number): Promise<string> => {
    const deviceId = BigInt(9_400_000_000 + (NS % 100_000) * 10 + deviceIds.length);
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

    zoneId = (await prisma.zone.create({ data: { name: 'Z-disp-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-disp-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-disp-' + NS, zoneId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@disp.test`, zoneId },
    });
    userIds.push(u.userId);
    dedicated = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: dedicated, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
    await prisma.seCoverage.create({ data: { seId: dedicated, plantId, coverageType: 'DEDICATED' } });

    await makeTicket(plantId, 120);
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

  it('dispatches one ACTIVE, SYSTEM_GENERATED WorkSchedule per SE with no approval gate', async () => {
    const schedules = await prisma.workSchedule.findMany({ where: { zoneId, seId: dedicated } });
    expect(schedules).toHaveLength(1);
    expect(schedules[0].status).toBe('ACTIVE'); // no DRAFT/PENDING_REVIEW/APPROVED — gate removed
    expect(schedules[0].source).toBe('SYSTEM_GENERATED');
    expect(schedules[0].dispatchedAt).not.toBeNull();
  });

  it('groups the plant tickets into one AUTO_ASSIGNED Plant-wise Batch Assignment', async () => {
    const schedule = await prisma.workSchedule.findFirstOrThrow({ where: { zoneId, seId: dedicated } });
    const batches = await prisma.plantBatchAssignment.findMany({ where: { scheduleId: schedule.scheduleId } });
    expect(batches).toHaveLength(1);
    expect(batches[0].plantId).toBe(plantId);
    expect(batches[0].seId).toBe(dedicated);
    expect(batches[0].status).toBe('AUTO_ASSIGNED');
  });

  it('persists both tickets as batch_assignment_tickets under the batch', async () => {
    const schedule = await prisma.workSchedule.findFirstOrThrow({ where: { zoneId, seId: dedicated } });
    const batch = await prisma.plantBatchAssignment.findFirstOrThrow({ where: { scheduleId: schedule.scheduleId } });
    const rows = await prisma.batchAssignmentTicket.findMany({ where: { batchId: batch.batchId } });
    expect(rows.map((r) => r.ticketId).sort()).toEqual([...ticketIds].sort());
  });

  it('flips dispatched tickets to FORMALLY_ASSIGNED so they leave the Shared Pool (Issue 12)', async () => {
    const tickets = await prisma.ticket.findMany({ where: { ticketId: { in: ticketIds } } });
    expect(tickets.every((t) => t.assignmentState === 'FORMALLY_ASSIGNED')).toBe(true);
  });
});
