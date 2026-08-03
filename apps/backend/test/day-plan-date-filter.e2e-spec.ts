import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { DayPlanQueryService } from '../src/scheduling/day-plan-query.service';

/**
 * Issue 147 slice 1 — the day-plan read is date-filtered.
 *
 * `getDayPlan` selected the newest live schedule with **no date predicate**, so an SE with no
 * dispatched work today opened the app and was served yesterday's stops as today's, indistinguishable
 * from a fresh plan. #127's APPEND made the compensating `orderBy: { dispatchedAt: 'desc' }` worse
 * still: appending to an existing schedule does not refresh `dispatchedAt`, so the ordering key no
 * longer tracks last-modification and can hand back an arbitrarily old plan.
 *
 * Three-case truth table, hand-built schedules (not the dispatch pipeline) so the dates and the
 * `dispatchedAt` stamps are exactly the ones under test.
 */
const NS = Date.now();
const NOW = new Date('2026-08-04T06:00:00Z');
const TODAY = new Date('2026-08-04T00:00:00Z');
const YESTERDAY = new Date('2026-08-03T00:00:00Z');

describe('Issue 147 slice 1 — getDayPlan is date-filtered', () => {
  let prisma: PrismaService;
  let dayPlan: DayPlanQueryService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  const scheduleIds: bigint[] = [];

  const makeSe = async (): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@dpdate.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({
      data: { engineerId: u.userId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 },
    });
    return u.userId;
  };

  const makeTicket = async (): Promise<string> => {
    const deviceId = String(9_710_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        hasOpenFailureCycle: true,
        latestGpsDatetime: NOW,
        plantId,
        companyId,
        computedAt: NOW,
      },
    });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
    const t = await prisma.ticket.create({
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
    ticketIds.push(t.ticketId);
    return t.ticketId;
  };

  /** A live one-stop schedule for `seId` covering exactly `day`, stamped `dispatchedAt`. */
  const makeSchedule = async (seId: string, day: Date, dispatchedAt: Date): Promise<string> => {
    const schedule = await prisma.workSchedule.create({
      data: {
        seId,
        zoneId,
        dateFrom: day,
        dateTo: day,
        status: 'ACTIVE',
        source: 'SYSTEM_GENERATED',
        dispatchedAt,
      },
    });
    scheduleIds.push(schedule.scheduleId);
    const batch = await prisma.plantBatchAssignment.create({
      data: { scheduleId: schedule.scheduleId, plantId, seId, status: 'AUTO_ASSIGNED', stopSequence: 1 },
    });
    await prisma.batchAssignmentTicket.create({
      data: { batchId: batch.batchId, ticketId: await makeTicket(), sortOrder: 1 },
    });
    return String(schedule.scheduleId);
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    dayPlan = new DayPlanQueryService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-dpd-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-dpd-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-dpd-' + NS, zoneId } })).plantId;
  });

  afterAll(async () => {
    const batches = await prisma.plantBatchAssignment.findMany({
      where: { scheduleId: { in: scheduleIds } },
      select: { batchId: true },
    });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.workSchedule.deleteMany({ where: { scheduleId: { in: scheduleIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('(a) serves the empty plan — never yesterday\'s — to an SE whose only live schedule is past-dated', async () => {
    const se = await makeSe();
    await makeSchedule(se, YESTERDAY, new Date('2026-08-03T05:00:00Z'));

    const view = await dayPlan.getDayPlan(se, { now: NOW });

    expect(view.dispatched).toBe(false);
    expect(view.scheduleId).toBeNull();
    expect(view.stops).toEqual([]);
  });

  it("(b) serves today's plan to an SE who has one", async () => {
    const se = await makeSe();
    const todays = await makeSchedule(se, TODAY, new Date('2026-08-04T05:00:00Z'));

    const view = await dayPlan.getDayPlan(se, { now: NOW });

    expect(view.dispatched).toBe(true);
    expect(view.scheduleId).toBe(todays);
    expect(view.dateFrom).toBe('2026-08-04');
    expect(view.stops).toHaveLength(1);
  });

  // The assertion that matters most: it fails for a DIFFERENT reason than (a) and would survive a
  // naive fix that only guarded the empty case. Under #127's APPEND, today's schedule keeps the
  // `dispatchedAt` of the run that created it while yesterday's can carry a newer stamp, so ordering
  // alone picks the wrong plan — the date predicate, not the ordering, has to decide.
  it("(c) serves today's plan even when yesterday's schedule carries the newer dispatchedAt", async () => {
    const se = await makeSe();
    const todays = await makeSchedule(se, TODAY, new Date('2026-08-04T04:00:00Z'));
    await makeSchedule(se, YESTERDAY, new Date('2026-08-04T05:00:00Z')); // newer stamp, older day

    const view = await dayPlan.getDayPlan(se, { now: NOW });

    expect(view.dispatched).toBe(true);
    expect(view.scheduleId).toBe(todays);
    expect(view.dateFrom).toBe('2026-08-04');
  });
});
