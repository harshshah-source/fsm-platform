import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { DispatchRunService } from '../src/scheduling/dispatch-run.service';
import { expectRan } from './dispatch-outcome';

/**
 * #179 Slice 2 — `DispatchRunService.runForActiveZones` gains an optional `zoneId` opt, narrowing
 * the zone loop to a single zone (the second bulk-unassign button, zone-scoped). Omitted must stay
 * byte-identical to today: both tests here share one fixture (two zones, one eligible ticket each)
 * to make the contrast direct — narrowed sweeps one, omitted sweeps both.
 */
const NS = Date.now();
const NOW = new Date('2026-07-29T06:00:00Z');

describe('DispatchRunService.runForActiveZones — optional zoneId (#179 slice 2)', () => {
  let prisma: PrismaService;
  let svc: DispatchRunService;

  let zoneA: bigint;
  let zoneB: bigint;
  let companyA: bigint;
  let companyB: bigint;
  let plantA: bigint;
  let plantB: bigint;
  let seA: string;
  let seB: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  const runIds: bigint[] = [];

  const makeZoneFixture = async (label: string) => {
    const zoneId = (await prisma.zone.create({ data: { name: `Z-scoped-${label}-` + NS } })).zoneId;
    const companyId = (await prisma.company.create({ data: { name: `Co-scoped-${label}-` + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    const plantId = (await prisma.plant.create({ data: { name: `P-scoped-${label}-` + NS, zoneId } })).plantId;
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({ data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@scoped.test`, zoneId } });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({ data: { engineerId: u.userId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
    await prisma.seCoverage.create({ data: { seId: u.userId, plantId, coverageType: 'DEDICATED' } });

    const deviceId = String(9_811_000_000 + (NS % 100_000) * 100 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: { deviceId, isInactive: true, slaBucket: 'CRITICAL', eligibleForUptime: true, hasOpenFailureCycle: true, latestGpsDatetime: new Date(NOW.getTime() - 120 * 60_000), plantId, companyId, computedAt: NOW },
    });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
    const ticket = await prisma.ticket.create({
      data: { workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: cycle.cycleId, deviceId, plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: NOW },
    });
    ticketIds.push(ticket.ticketId);

    return { zoneId, companyId, plantId, seId: u.userId, ticketId: ticket.ticketId };
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new DispatchRunService(prisma, new RecommenderService(prisma, new CandidateSelectionService(prisma)), new BatchAssignmentService(prisma));

    const a = await makeZoneFixture('a');
    zoneA = a.zoneId; companyA = a.companyId; plantA = a.plantId; seA = a.seId;
    const b = await makeZoneFixture('b');
    zoneB = b.zoneId; companyB = b.companyId; plantB = b.plantId; seB = b.seId;
  });

  afterAll(async () => {
    const allZoneIds = [zoneA, zoneB];
    const allPlantIds = [plantA, plantB];
    const allCompanyIds = [companyA, companyB];
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    const schedules = await prisma.workSchedule.findMany({ where: { zoneId: { in: allZoneIds } }, select: { scheduleId: true } });
    const batches = await prisma.plantBatchAssignment.findMany({ where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } }, select: { batchId: true } });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.workSchedule.deleteMany({ where: { zoneId: { in: allZoneIds } } });
    await prisma.dispatchRunZone.deleteMany({ where: { runId: { in: runIds } } });
    // #180 R1.1 — keyed on ticketId this deleted only THIS spec's own traces; an unnarrowed
    // runForActiveZones (the second test) sweeps every plant-bearing zone and can write a decision
    // trace for a foreign ticket under this run's runId, which then blocks dispatchRun.deleteMany's
    // FK. Key on runId (what the FK actually constrains) instead, immediately before that delete.
    await prisma.dispatchDecisionTrace.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.dispatchRun.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.auditLog.deleteMany({ where: { entityType: 'dispatch_run', entityId: { in: runIds.map(String) } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seCoverage.deleteMany({ where: { plantId: { in: allPlantIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: allPlantIds } } });
    await prisma.company.deleteMany({ where: { companyId: { in: allCompanyIds } } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: allZoneIds } } });
    await prisma.onModuleDestroy();
  });

  it('a zoneId opt narrows the run to that single zone, leaving the other zone untouched', async () => {
    const summary = expectRan(await svc.runForActiveZones(NOW, { zoneId: zoneA }));
    runIds.push(BigInt(summary.runId));

    expect(summary.zones).toBe(1);

    const ticketA = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: ticketIds[0] } });
    expect(ticketA.assignmentState).toBe('FORMALLY_ASSIGNED');

    // Zone B's ticket must be completely untouched — never even considered.
    const ticketB = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: ticketIds[1] } });
    expect(ticketB.assignmentState).toBe('UNASSIGNED');
    const zoneBSchedules = await prisma.workSchedule.findMany({ where: { zoneId: zoneB } });
    expect(zoneBSchedules).toHaveLength(0);

    const zoneRows = await prisma.dispatchRunZone.findMany({ where: { runId: BigInt(summary.runId) } });
    expect(zoneRows).toHaveLength(1);
    expect(zoneRows[0].zoneId).toBe(zoneA);
  });

  it('omitting zoneId still sweeps every active zone (byte-identical to today)', async () => {
    const summary = expectRan(await svc.runForActiveZones(NOW));
    runIds.push(BigInt(summary.runId));

    // Both zones' tickets are now dispatched — the omitted-zoneId path is unnarrowed.
    const ticketA = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: ticketIds[0] } });
    const ticketB = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: ticketIds[1] } });
    expect(ticketA.assignmentState).toBe('FORMALLY_ASSIGNED'); // already true from the first test (idempotent re-run)
    expect(ticketB.assignmentState).toBe('FORMALLY_ASSIGNED'); // newly dispatched by this sweep

    const zoneRows = await prisma.dispatchRunZone.findMany({ where: { runId: BigInt(summary.runId) } });
    const sweptZoneIds = new Set(zoneRows.map((r) => r.zoneId.toString()));
    expect(sweptZoneIds.has(zoneA.toString())).toBe(true);
    expect(sweptZoneIds.has(zoneB.toString())).toBe(true);
  });
});
