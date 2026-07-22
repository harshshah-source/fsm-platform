import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { DayPlanQueryService } from '../src/scheduling/day-plan-query.service';
import { LoggingDayPlanNotifier } from '../src/scheduling/day-plan-notifier';
import { OverrideService } from '../src/scheduling/override.service';

/**
 * #153 — `OVERRIDDEN` is a LIVE work-schedule state, not a terminal one. The business workflow
 * (`fsm-business-technical-workflow.md:1913`) transitions `AUTO_ASSIGNED → OVERRIDDEN → COMPLETED |
 * PARTIAL`: once a ZM adjusts a day plan the SE still has to work it. Every ZM override flips the
 * schedule to `OVERRIDDEN` (`override.service.ts:487-490`), so any reader that filters `status:
 * 'ACTIVE'` treats the whole schedule as non-existent the moment a ZM touches it.
 *
 * Two consequences are proved here at their user-facing seams:
 *
 *  1. **The SE's day plan goes blank.** `getDayPlan` returns the empty-state instead of the remaining
 *     work — not a plan missing one stop, but no work at all.
 *  2. **The SE's committed load resets to zero.** `committedDayLoad` seeds the recommender's per-run
 *     `assigned` counter, so an overridden SE reads as entirely free and the next dispatch run can
 *     hand them a fresh full day of capacity ON TOP of the work already in their (invisible) plan.
 *
 * The widening is deliberately EXACTLY ONE value: `COMPLETED` (and `PARTIAL`) must stay excluded, or a
 * sloppy "drop the status filter" fix silently resurrects finished work onto today's plan. The pin
 * below is what makes that provable rather than assumed.
 */
const NS = Date.now();

describe('#153 — an overridden schedule is still live: the SE day plan survives an override', () => {
  let prisma: PrismaService;
  let rec: RecommenderService;
  let dispatch: BatchAssignmentService;
  let override: OverrideService;
  let dayPlan: DayPlanQueryService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantA: bigint;
  let plantB: bigint;
  let se: string;
  let batchA: bigint;
  let scheduleId: bigint;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  let ticketA: string;
  const ZM = { userId: '11111111-1111-1111-1111-111111111111', role: 'ZONAL_MANAGER', actedAsRole: null };
  const NOW = new Date('2026-06-21T06:00:00Z');

  const makeTicket = async (plant: bigint, gpsAgeMin: number): Promise<string> => {
    const deviceId = String(10_530_000_000 + (NS % 100_000) * 10 + deviceIds.length);
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
    dayPlan = new DayPlanQueryService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-osl-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-osl-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantA = (await prisma.plant.create({ data: { name: 'P-A-osl-' + NS, zoneId } })).plantId;
    plantB = (await prisma.plant.create({ data: { name: 'P-B-osl-' + NS, zoneId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@osl.test`, zoneId },
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
    scheduleId = (await prisma.workSchedule.findFirstOrThrow({ where: { seId: se, zoneId } })).scheduleId;
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
    await prisma.auditLog.deleteMany({ where: { entityType: 'plant_batch_assignment', entityId: String(batchA) } });
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

  it('control — before any override the SE sees their dispatched day plan', async () => {
    const plan = await dayPlan.getDayPlan(se);
    expect(plan.dispatched).toBe(true);
    expect(plan.stops.flatMap((s) => s.tickets)).toHaveLength(2);
  });

  it('the day plan survives a ZM override — it does not go blank', async () => {
    await override.override(
      batchA,
      { action: 'DEFER_TICKET', ticketId: ticketA, deferredToDate: '2026-06-25', reasonCode: 'PARTS_ETA' },
      { role: 'ZONAL_MANAGER', zoneId: Number(zoneId) },
      ZM,
    );
    // Pre-condition: the override really did flip the SCHEDULE, not just the batch — that flip is the
    // mechanism under test, so assert it rather than trusting it.
    const sched = await prisma.workSchedule.findUniqueOrThrow({ where: { scheduleId } });
    expect(sched.status).toBe('OVERRIDDEN');

    const plan = await dayPlan.getDayPlan(se);
    expect(plan.dispatched).toBe(true);
    // Pre-#146 this is still BOTH tickets — DEFER_TICKET has no read semantics yet (that is #146
    // slice 1). The assertion here is only that an override does not blank the whole plan.
    expect(plan.stops.flatMap((s) => s.tickets).length).toBeGreaterThan(0);
  });

  it('PIN — a COMPLETED schedule stays excluded: the widening is exactly one status', async () => {
    await prisma.workSchedule.update({ where: { scheduleId }, data: { status: 'COMPLETED' } });
    try {
      const plan = await dayPlan.getDayPlan(se);
      expect(plan.dispatched).toBe(false);
      expect(plan.stops).toHaveLength(0);
    } finally {
      await prisma.workSchedule.update({ where: { scheduleId }, data: { status: 'OVERRIDDEN' } });
    }
  });
});

/**
 * The capacity half of #153, proved at the recommender's real seam (`runForZone` → recommendation
 * status), NOT by re-issuing the `committedDayLoad` query in the test — a test that recomputes the
 * production query cannot disagree with it.
 *
 * This is the exact fixture of `recommender-cross-zone-capacity.e2e-spec.ts` (NEW-A1) with one
 * difference: the SE's already-committed day plan sits on an OVERRIDDEN schedule instead of an ACTIVE
 * one. That spec proves the cap holds for `ACTIVE`; this one proves a ZM override does not silently
 * reset the SE's committed load to zero and re-open them for a full second day of work.
 */
describe('#153 — an overridden schedule still consumes the SE daily capacity', () => {
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

  const NOW = new Date('2026-06-23T06:00:00Z');
  const DAY = new Date(Date.UTC(2026, 5, 23)); // utc-midnight of NOW — the Day Plan's coverage date

  const makeTicket = async (plant: bigint): Promise<string> => {
    const deviceId = String(10_560_000_000 + (NS % 100_000) * 10 + deviceIds.length);
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

    zoneA = (await prisma.zone.create({ data: { name: 'ZA-oslc-' + NS } })).zoneId;
    zoneB = (await prisma.zone.create({ data: { name: 'ZB-oslc-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-oslc-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantA = (await prisma.plant.create({ data: { name: 'PA-oslc-' + NS, zoneId: zoneA } })).plantId;
    plantB = (await prisma.plant.create({ data: { name: 'PB-oslc-' + NS, zoneId: zoneB } })).plantId;

    // One SE, capacity 1, home zone A but covering a plant in BOTH zones (cross-zone territory).
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@oslc.test`, zoneId: zoneA },
    });
    userIds.push(u.userId);
    seId = u.userId;
    await prisma.engineerMaster.create({
      data: { engineerId: seId, coverageType: 'MULTI_PLANT', zoneId: zoneA, dailyCapacity: 1 },
    });
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

  it('does NOT re-book an SE whose committed day plan sits on an OVERRIDDEN schedule', async () => {
    // Zone A's morning batch, already committed AND since adjusted by the ZM: 1 stop on the SE's day
    // plan for DAY, on a schedule the override flipped to OVERRIDDEN. The SE still has to work it.
    const anchorTicket = await makeTicket(plantA);
    const schedule = await prisma.workSchedule.create({
      data: { seId, zoneId: zoneA, dateFrom: DAY, dateTo: DAY, status: 'OVERRIDDEN' },
    });
    scheduleId = schedule.scheduleId;
    const batch = await prisma.plantBatchAssignment.create({
      data: { scheduleId: schedule.scheduleId, plantId: plantA, seId, stopSequence: 1, status: 'OVERRIDDEN' },
    });
    batchId = batch.batchId;
    await prisma.batchAssignmentTicket.create({ data: { batchId: batch.batchId, ticketId: anchorTicket, sortOrder: 1 } });

    // Re-run zone B. The control run's runId-null SUGGESTED is cleared by the #126 orphan sweep, so the
    // zone-B ticket is re-evaluated fresh — and the SE is already at capacity (1/1) from zone A.
    await rec.runForZone(zoneB, { now: NOW });

    const r = await recFor(ticketIds[0]); // the zone-B ticket
    expect(r?.seId).toBeNull();
    expect(r?.status).toBe('UNASSIGNABLE');
  });
});
