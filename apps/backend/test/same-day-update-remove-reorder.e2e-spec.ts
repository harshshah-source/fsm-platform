import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { LoggingDayPlanNotifier } from '../src/scheduling/day-plan-notifier';
import { OverrideService } from '../src/scheduling/override.service';
import { SameDayUpdateService } from '../src/scheduling/same-day-update.service';

/**
 * Issue 31 slice 2 — ZM same-day REMOVE + REORDER. Both reuse the Issue 13 override engine but tag the
 * change as `MANUAL_ZM_UPDATE` so it surfaces in the Intra-day Queue (REMOVE / REORDER updateType). The
 * ON_SITE conflict gate (mandatory confirm + reason) flows through the same-day path unchanged (AC#3).
 */
const NS = Date.now();

describe('Issue 31 slice 2 — ZM same-day REMOVE + REORDER', () => {
  let prisma: PrismaService;
  let rec: RecommenderService;
  let dispatch: BatchAssignmentService;
  let sameDay: SameDayUpdateService;

  const onsite = new Set<string>();
  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let se: string;
  let batchId: bigint;
  let tA: string;
  let tB: string;
  const userIds: string[] = [];
  const deviceIds: bigint[] = [];
  const ticketIds: string[] = [];
  const ZM = { userId: '31222222-2222-2222-2222-222222222222', role: 'ZONAL_MANAGER', actedAsRole: null };
  const NOW = new Date('2026-06-25T06:00:00Z');
  let scope: { role: string; zoneId: number };

  const makeTicket = async (gpsAgeMin: number): Promise<string> => {
    const deviceId = BigInt(11_100_000_000 + (NS % 100_000) * 10 + deviceIds.length);
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
        plantId,
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
        plantId,
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
    const conflictPort = { activeOnSiteTicketIds: async (ids: string[]) => new Set(ids.filter((i) => onsite.has(i))) };
    const override = new OverrideService(prisma, new AuditService(prisma), new LoggingDayPlanNotifier(), conflictPort);
    sameDay = new SameDayUpdateService(prisma, override);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-sdr-' + NS } })).zoneId;
    scope = { role: 'ZONAL_MANAGER', zoneId: Number(zoneId) };
    companyId = (
      await prisma.company.create({ data: { name: 'Co-sdr-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-sdr-' + NS, zoneId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'sdr-' + tag, email: `${tag}-${NS}@sdr.test`, zoneId },
    });
    userIds.push(u.userId);
    se = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
    await prisma.seCoverage.create({ data: { seId: se, plantId, coverageType: 'DEDICATED' } });

    tA = await makeTicket(180);
    tB = await makeTicket(60);

    await rec.runForZone(zoneId, { now: NOW });
    await dispatch.dispatchForZone(zoneId, { dateFrom: NOW, dateTo: NOW, now: NOW });
    batchId = (await prisma.plantBatchAssignment.findFirstOrThrow({ where: { plantId } })).batchId;
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
    await prisma.auditLog.deleteMany({ where: { entityType: 'plant_batch_assignment', entityId: String(batchId) } });
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

  it('removes a ticket immediately and logs a MANUAL_ZM_UPDATE/REMOVE intra-day row', async () => {
    const out = await sameDay.removeTicket(batchId, tA, 'WRONG_PLANT', false, scope, ZM, NOW);
    expect(out.result).toBe('OK');
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: tA } });
    expect(ticket.assignmentState).toBe('UNASSIGNED');

    const updates = await sameDay.listIntradayUpdates(scope);
    const row = updates.find((u) => u.updateType === 'REMOVE' && u.ticketId === tA);
    expect(row).toBeDefined();
    expect(row!.seId).toBe(se);
    expect(row!.actorId).toBe(ZM.userId);
  });

  it('gates removing an ON_SITE ticket behind confirm + reason (AC#3), then commits on confirm', async () => {
    onsite.add(tB);
    const blocked = await sameDay.removeTicket(batchId, tB, 'RESEQUENCE', false, scope, ZM, NOW);
    expect(blocked.result).toBe('CONFLICT_ON_SITE');

    const confirmed = await sameDay.removeTicket(batchId, tB, 'SE_REASSIGNED', true, scope, ZM, NOW);
    expect(confirmed.result).toBe('OK');
    onsite.delete(tB);
  });

  it('reorders a stop and logs a MANUAL_ZM_UPDATE/REORDER intra-day row', async () => {
    const out = await sameDay.reorder(batchId, 1, 'RESEQUENCE', scope, ZM, NOW);
    expect(out.result).toBe('OK');
    const updates = await sameDay.listIntradayUpdates(scope);
    expect(updates.some((u) => u.updateType === 'REORDER')).toBe(true);
  });
});
