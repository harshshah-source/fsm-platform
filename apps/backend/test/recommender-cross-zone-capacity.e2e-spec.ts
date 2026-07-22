import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';

/**
 * NEW-A1 (ticket-and-assignment audit 2026-07-21) — the recommender's daily-capacity gate must count an
 * SE's *whole committed day plan*, not just the tickets assigned inside the current zone-run. A FLOATING /
 * MULTI_PLANT SE whose coverage spans two FSM zones is otherwise dispatched up to `daily_capacity` in EACH
 * zone the daily loop visits (the `assigned` map starts empty per `runForZone`), a silent 2×–N× over-book
 * that every per-zone ledger reports as correct in isolation.
 *
 * The fix seeds the per-run `assigned` map from the SE's already-committed day plan (ACTIVE work_schedules
 * → batches → non-removed batch_tickets for the run day). This test proves it end-to-end: one SE, capacity
 * 1, covering a plant in zone A and a plant in zone B. With zone A's one stop already on the SE's day plan,
 * a fresh zone-B ticket must fall through to UNASSIGNABLE (SE over capacity) — NOT be re-suggested.
 */
const NS = Date.now();

describe('NEW-A1 — recommender enforces daily capacity across zones (committed day plan)', () => {
  let prisma: PrismaService;
  let rec: RecommenderService;

  let zoneA: bigint;
  let zoneB: bigint;
  let companyId: bigint;
  let plantA: bigint;
  let plantB: bigint;
  let seId: string;

  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  let scheduleId: bigint | undefined;
  let batchId: bigint | undefined;

  const NOW = new Date('2026-06-22T06:00:00Z');
  const DAY = new Date(Date.UTC(2026, 5, 22)); // utc-midnight of NOW — the Day Plan's single coverage date

  /** Seed an inactive device + OPEN/UNASSIGNED TROUBLESHOOT ticket at a plant; returns the ticketId. */
  const makeTicket = async (plant: bigint): Promise<string> => {
    const deviceId = String(9_400_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        hasOpenFailureCycle: true,
        latestGpsDatetime: new Date(NOW.getTime() - 120 * 60_000),
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

    zoneA = (await prisma.zone.create({ data: { name: 'ZA-xzc-' + NS } })).zoneId;
    zoneB = (await prisma.zone.create({ data: { name: 'ZB-xzc-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-xzc-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantA = (await prisma.plant.create({ data: { name: 'PA-xzc-' + NS, zoneId: zoneA } })).plantId;
    plantB = (await prisma.plant.create({ data: { name: 'PB-xzc-' + NS, zoneId: zoneB } })).plantId;

    // One SE, capacity 1, home zone A but covering a plant in BOTH zones (cross-zone territory).
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@xzc.test`, zoneId: zoneA },
    });
    userIds.push(u.userId);
    seId = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: seId, coverageType: 'MULTI_PLANT', zoneId: zoneA, dailyCapacity: 1 } });
    await prisma.seCoverage.create({ data: { seId, plantId: plantA, coverageType: 'MULTI_PLANT' } });
    await prisma.seCoverage.create({ data: { seId, plantId: plantB, coverageType: 'MULTI_PLANT' } });
  });

  afterAll(async () => {
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId } });
    if (batchId) await prisma.plantBatchAssignment.deleteMany({ where: { batchId } });
    if (scheduleId) await prisma.workSchedule.deleteMany({ where: { scheduleId } });
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seCoverage.deleteMany({ where: { seId } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [plantA, plantB] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: [zoneA, zoneB] } } });
    await prisma.onModuleDestroy();
  });

  const recFor = (ticketId: string) =>
    prisma.recommendation.findFirst({ where: { ticketId }, orderBy: { recommendationId: 'desc' } });

  it('control — with no committed day plan, the SE is eligible for the zone-B ticket', async () => {
    const t = await makeTicket(plantB);
    await rec.runForZone(zoneB, { now: NOW });
    const r = await recFor(t);
    expect(r?.seId).toBe(seId);
    expect(r?.status).toBe('SUGGESTED');
  });

  it('does NOT re-book the SE in zone B once zone A has already spent their daily capacity', async () => {
    // Simulate zone A's morning batch already committed: 1 stop on the SE's ACTIVE day plan for DAY.
    const anchorTicket = await makeTicket(plantA); // a real ticket to hang the committed batch stop on
    const schedule = await prisma.workSchedule.create({
      data: { seId, zoneId: zoneA, dateFrom: DAY, dateTo: DAY, status: 'ACTIVE' },
    });
    scheduleId = schedule.scheduleId;
    const batch = await prisma.plantBatchAssignment.create({
      data: { scheduleId: schedule.scheduleId, plantId: plantA, seId, stopSequence: 1 },
    });
    batchId = batch.batchId;
    await prisma.batchAssignmentTicket.create({ data: { batchId: batch.batchId, ticketId: anchorTicket, sortOrder: 1 } });

    // Re-run zone B. The prior control run's runId-null SUGGESTED is cleared by #126 orphan sweep, so the
    // zone-B ticket is re-evaluated fresh — and this time the SE is already at capacity (1/1) from zone A.
    await rec.runForZone(zoneB, { now: NOW });

    const r = await recFor(ticketIds[0]); // the zone-B ticket
    expect(r?.seId).toBeNull();
    expect(r?.status).toBe('UNASSIGNABLE');
  });
});
