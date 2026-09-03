import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { DispatchRunService } from '../src/scheduling/dispatch-run.service';

/**
 * #270 — the trace/preview never claim a PASSED for a filter whose feed does not exist yet.
 * `VEHICLE_ON_TRIP` (Issue 28) and `COMPONENT_UNAVAILABLE` (Issue 22) are stubbed feeds today
 * (`candidate-readiness.ts`); every trace row must show them NOT_ENFORCED, never PASSED, while the
 * three real filters (SE_UNAVAILABLE/OVER_CAPACITY/COMMON_KIT_INCOMPLETE) keep reporting for real.
 */
const NS = Date.now();
const NOW = new Date('2026-08-10T06:00:00Z');

describe('#270 — honest filter transparency', () => {
  let prisma: PrismaService;
  let rec: RecommenderService;
  let runs: DispatchRunService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let seId: string;
  let runId: bigint;
  const userIds: string[] = [];
  let deviceId: string;
  let ticketId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    rec = new RecommenderService(prisma, new CandidateSelectionService(prisma));
    runs = new DispatchRunService(prisma, rec, new BatchAssignmentService(prisma));

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

    zoneId = (await prisma.zone.create({ data: { name: 'Z-fh-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-fh-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-fh-' + NS, zoneId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'fh-' + tag, email: `${tag}@fh.test`, zoneId },
    });
    seId = u.userId;
    userIds.push(seId);
    await prisma.engineerMaster.create({
      data: { engineerId: seId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 5 },
    });
    await prisma.seCoverage.create({ data: { seId, plantId, coverageType: 'DEDICATED' } });

    deviceId = String(9_500_000_000 + (NS % 100_000));
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        hasOpenFailureCycle: true,
        latestGpsDatetime: new Date(NOW.getTime() - 120 * 60_000),
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
    ticketId = ticket.ticketId;

    const outcome = await runs.runForActiveZones(NOW, { zoneId, trigger: 'MANUAL' });
    expect(outcome.result).toBe('RAN');
    const row = await prisma.dispatchRunZone.findFirstOrThrow({ where: { zoneId }, orderBy: { id: 'desc' } });
    runId = row.runId;
  });

  afterAll(async () => {
    const ledger = await prisma.dispatchRun.findMany({ where: { zoneRows: { some: { zoneId } } }, select: { runId: true } });
    const schedules = await prisma.workSchedule.findMany({ where: { zoneId }, select: { scheduleId: true } });
    const batches = await prisma.plantBatchAssignment.findMany({
      where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } },
      select: { batchId: true },
    });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.workSchedule.deleteMany({ where: { zoneId } });
    await prisma.dispatchDecisionTrace.deleteMany({ where: { ticketId } });
    await prisma.recommendation.deleteMany({ where: { ticketId } });
    await prisma.dispatchRun.deleteMany({ where: { runId: { in: ledger.map((r) => r.runId) } } });
    await prisma.auditLog.deleteMany({
      where: { entityType: 'dispatch_run', entityId: { in: ledger.map((r) => r.runId.toString()) } },
    });
    await prisma.ticketEvent.deleteMany({ where: { ticketId } });
    await prisma.ticket.deleteMany({ where: { ticketId } });
    await prisma.failureCycle.deleteMany({ where: { deviceId } });
    await prisma.seCoverage.deleteMany({ where: { plantId } });
    await prisma.deviceState.deleteMany({ where: { deviceId } });
    await prisma.device.deleteMany({ where: { deviceId } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  const traceFor = async () => {
    const row = await prisma.dispatchDecisionTrace.findFirstOrThrow({ where: { runId, ticketId } });
    return row.trace as Record<string, any>;
  };

  it('AC1 — the winner\'s filterStates show VEHICLE_ON_TRIP/COMPONENT_UNAVAILABLE as NOT_ENFORCED, never PASSED', async () => {
    const trace = await traceFor();
    expect(trace.chosen.seId).toBe(seId);
    const states: { filter: string; state: string }[] = trace.chosen.filterStates;
    expect(states.find((s) => s.filter === 'VEHICLE_ON_TRIP')?.state).toBe('NOT_ENFORCED');
    expect(states.find((s) => s.filter === 'COMPONENT_UNAVAILABLE')?.state).toBe('NOT_ENFORCED');
    for (const s of states) {
      if (s.filter === 'VEHICLE_ON_TRIP' || s.filter === 'COMPONENT_UNAVAILABLE') {
        expect(s.state).not.toBe('PASSED');
      }
    }
  });

  it('AC1 — the trace\'s notEnforcedFilters names exactly the two stubbed feeds', async () => {
    const trace = await traceFor();
    expect(trace.notEnforcedFilters.sort()).toEqual(['COMPONENT_UNAVAILABLE', 'VEHICLE_ON_TRIP']);
  });

  it('AC2 — the real filters report PASSED for real for a clean candidate, drop behaviour untouched', async () => {
    const trace = await traceFor();
    const states: { filter: string; state: string }[] = trace.chosen.filterStates;
    expect(states.find((s) => s.filter === 'SE_UNAVAILABLE')?.state).toBe('PASSED');
    expect(states.find((s) => s.filter === 'OVER_CAPACITY')?.state).toBe('PASSED');
    expect(states.find((s) => s.filter === 'COMMON_KIT_INCOMPLETE')?.state).toBe('PASSED');
  });
});
