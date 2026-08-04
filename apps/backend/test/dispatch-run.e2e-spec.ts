import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { DispatchRunService } from '../src/scheduling/dispatch-run.service';
import { expectRan } from './dispatch-outcome';

/**
 * Issue 113 — the missing middle of the funnel. `DispatchRunService.runForActiveZones` is the
 * orchestrator a daily tick (and the manual HTTP trigger) call: for every active zone it runs the
 * Recommender then the Day-Plan dispatch, so an OPEN/UNASSIGNED ticket actually reaches an SE with no
 * per-zone human step. Seam: `runForActiveZones(now)` observed through the persisted Day Plan.
 */
const NS = Date.now();
const NOW = new Date('2026-06-21T06:00:00Z');

describe('Issue 113 — DispatchRunService.runForActiveZones', () => {
  let prisma: PrismaService;
  let svc: DispatchRunService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let seId: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];

  const makeTicket = async (gpsAgeMin: number): Promise<string> => {
    const deviceId = String(9_530_000_000 + (NS % 100_000) * 10 + deviceIds.length);
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
    svc = new DispatchRunService(prisma, new RecommenderService(prisma, new CandidateSelectionService(prisma)), new BatchAssignmentService(prisma));

    zoneId = (await prisma.zone.create({ data: { name: 'Z-run-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-run-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-run-' + NS, zoneId } })).plantId;
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({ data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@run.test`, zoneId } });
    userIds.push(u.userId);
    seId = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: seId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
    await prisma.seCoverage.create({ data: { seId, plantId, coverageType: 'DEDICATED' } });
    await makeTicket(120);
  });

  afterAll(async () => {
    // Ledger cleanup: runs this spec opened (deleting a run cascades its zone rows and SET-NULLs the
    // run_id stamps; deleting recommendations cascades their decision traces).
    const runs = await prisma.dispatchRun.findMany({
      where: { recommendations: { some: { ticketId: { in: ticketIds } } } },
      select: { runId: true },
    });
    const schedules = await prisma.workSchedule.findMany({ where: { zoneId }, select: { scheduleId: true } });
    const batches = await prisma.plantBatchAssignment.findMany({ where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } }, select: { batchId: true } });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.workSchedule.deleteMany({ where: { zoneId } });
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.dispatchRun.deleteMany({ where: { runId: { in: runs.map((r) => r.runId) } } });
    await prisma.auditLog.deleteMany({
      where: { entityType: 'dispatch_run', entityId: { in: runs.map((r) => r.runId.toString()) } },
    });
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

  it('scores + dispatches an OPEN UNASSIGNED ticket to a Day Plan across active zones', async () => {
    const summary = expectRan(await svc.runForActiveZones(NOW));
    expect(summary.tickets).toBeGreaterThanOrEqual(1);

    // The ticket in our zone is now on a dispatched Day Plan for the eligible SE.
    const schedules = await prisma.workSchedule.findMany({ where: { zoneId, seId } });
    expect(schedules).toHaveLength(1);
    expect(schedules[0].status).toBe('ACTIVE');
    expect(schedules[0].source).toBe('SYSTEM_GENERATED');

    const batch = await prisma.plantBatchAssignment.findFirstOrThrow({ where: { scheduleId: schedules[0].scheduleId } });
    expect(batch.status).toBe('AUTO_ASSIGNED');

    const ours = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: ticketIds[0] } });
    expect(ours.assignmentState).toBe('FORMALLY_ASSIGNED');
  });
});
