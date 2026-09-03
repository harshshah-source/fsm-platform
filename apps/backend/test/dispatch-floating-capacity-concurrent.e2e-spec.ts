import { randomUUID } from 'node:crypto';
import { istDate } from '../src/common/ist-day';
import { PrismaService } from '../src/prisma/prisma.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { committedDayLoad } from '../src/scheduling/committed-day-load';
import { raceTwiceUnbarriered } from './support/concurrency';

/**
 * #304 (forensics RC-4) — floating-SE capacity holds under CONCURRENT zone runs.
 *
 * `daily_capacity` caps an engineer's whole day, but the engine's counter is seeded from committed
 * rows once per zone-run and incremented only for that run's own wins; zone claims serialize per
 * **zone**, not per engineer; and `work_schedules_one_active_per_se_zone_day` is per-(SE, zone, day)
 * by design, so the database permits it. Two runs in different zones — a manual zone-scoped run, or a
 * #286 recovery beside the 05:00 loop — could each fill the same floating SE to capacity, and the
 * engineer's real day came out at up to twice it.
 *
 * `recommender-cross-zone-capacity.e2e-spec.ts` covers the SEQUENTIAL case and always passed: the
 * second run's seed sees the first run's committed rows. Concurrency is the gap, and it is the whole
 * subject here.
 *
 * SUGGESTED rows are written directly rather than through the recommender. That is deliberate: the
 * recommender's optimism is explicitly left alone by the issue, so what has to be proven is that the
 * **commit** refuses to exceed capacity no matter what it is handed.
 */
const NS = Date.now();

describe('#304 — concurrent zone runs cannot overfill one floating SE', () => {
  let prisma: PrismaService;
  let prismaOther: PrismaService;

  let companyId: bigint;
  let zoneA: bigint;
  let zoneB: bigint;
  let plantA: bigint;
  let plantB: bigint;
  let floatingSe: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  const runIds: bigint[] = [];
  const NOW = new Date('2026-06-21T06:00:00Z');
  const DAY = istDate(NOW);
  const CAPACITY = 5;

  const makeTicket = async (plantId: bigint): Promise<string> => {
    const deviceId = String(9_480_000_000 + (NS % 100_000) * 100 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
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

  /** What the recommender would have written: this SE, these tickets, SUGGESTED. */
  const suggest = async (ticketIdsForRun: string[]): Promise<bigint> => {
    const run = await prisma.dispatchRun.create({
      data: { trigger: 'CRON', status: 'RUNNING', startedAt: NOW, configSnapshot: {} },
    });
    runIds.push(run.runId);
    let rank = 0;
    for (const ticketId of ticketIdsForRun) {
      rank += 1;
      await prisma.recommendation.create({
        data: {
          ticketId,
          seId: floatingSe,
          status: 'SUGGESTED',
          path: 'MORNING_BATCH',
          scoreBreakdown: {},
          processingRank: rank,
          runId: run.runId,
        },
      });
    }
    return run.runId;
  };

  const engineLoad = async (): Promise<number> => (await committedDayLoad(prisma, DAY, { seIds: [floatingSe] })).get(floatingSe) ?? 0;

  const resetPlans = async (): Promise<void> => {
    const schedules = await prisma.workSchedule.findMany({
      where: { zoneId: { in: [zoneA, zoneB] } },
      select: { scheduleId: true },
    });
    const batches = await prisma.plantBatchAssignment.findMany({
      where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } },
      select: { batchId: true },
    });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.dayPlanNotificationOutbox.deleteMany({
      where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } },
    });
    await prisma.workSchedule.deleteMany({ where: { zoneId: { in: [zoneA, zoneB] } } });
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.updateMany({
      where: { ticketId: { in: ticketIds } },
      data: { assignmentState: 'UNASSIGNED' },
    });
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    // A second pool, so the two runs cannot see each other's memory — the same reasoning
    // `dispatch-zone-claim-admission` gives. A test driving one client twice proves nothing here.
    prismaOther = new PrismaService();
    await prismaOther.onModuleInit();

    companyId = (
      await prisma.company.create({ data: { name: 'Co-304-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    zoneA = (await prisma.zone.create({ data: { name: 'Z-304A-' + NS } })).zoneId;
    zoneB = (await prisma.zone.create({ data: { name: 'Z-304B-' + NS } })).zoneId;
    plantA = (await prisma.plant.create({ data: { name: 'P-304A-' + NS, zoneId: zoneA } })).plantId;
    plantB = (await prisma.plant.create({ data: { name: 'P-304B-' + NS, zoneId: zoneB } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE float ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@c304.test`, zoneId: zoneA },
    });
    userIds.push(u.userId);
    floatingSe = u.userId;
    await prisma.engineerMaster.create({
      data: { engineerId: floatingSe, coverageType: 'FLOATING', zoneId: zoneA, dailyCapacity: CAPACITY },
    });
    // No `se_coverage` rows: `se_coverage_not_floating_chk` forbids FLOATING there (floating reach is
    // `engineer_territory_coverage`), and the path under test does not read either. Dispatch claims
    // SUGGESTED rows by (se_id, plant's zone) and resolves coverage only for the
    // `coverage_type_at_assign` column, which tolerates a missing row. Seeding coverage the recommender
    // would need — and which this spec deliberately bypasses — would be staging for a different test.
  });

  afterEach(resetPlans);

  afterAll(async () => {
    await resetPlans();
    await prisma.dispatchRunZone.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.dispatchRun.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [plantA, plantB] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: [zoneA, zoneB] } } });
    await prismaOther.onModuleDestroy();
    await prisma.onModuleDestroy();
  });

  it('AC1/AC2 — two zones each offering a full day commit at most `dailyCapacity` between them', async () => {
    const inA: string[] = [];
    const inB: string[] = [];
    for (let i = 0; i < CAPACITY; i++) inA.push(await makeTicket(plantA));
    for (let i = 0; i < CAPACITY; i++) inB.push(await makeTicket(plantB));
    await suggest(inA);
    await suggest(inB);

    // Two services on two pools, started together. The engineer lock is what makes the outcome a
    // property of the code rather than of the interleaving — which is precisely the claim being made,
    // so an unbarriered start is honest here: whatever order they land in, the total must hold.
    const dispatchA = new BatchAssignmentService(prisma);
    const dispatchB = new BatchAssignmentService(prismaOther);
    const results = await raceTwiceUnbarriered(async () => {
      const [a, b] = await Promise.all([
        dispatchA.dispatchForZone(zoneA, { dateFrom: DAY, dateTo: DAY, now: NOW }),
        dispatchB.dispatchForZone(zoneB, { dateFrom: DAY, dateTo: DAY, now: NOW }),
      ]);
      return { a, b };
    });
    const first = results.find((r) => r.ok);
    expect(first?.ok).toBe(true);

    // AC1 — the invariant, stated as the engineer's real day rather than as either run's total.
    expect(await engineLoad()).toBeLessThanOrEqual(CAPACITY);

    // AC2 — and the surplus is named, not silently dropped.
    const summaries = results.flatMap((r) => (r.ok ? [r.value.a, r.value.b] : []));
    const capacitySkips = summaries.flatMap((s) => s.ticketSkips ?? []).filter((s) => s.reason === 'CAPACITY_REACHED');
    expect(capacitySkips.length).toBeGreaterThan(0);
  });

  it('AC1 — a second run finds no room at all once the day is full, and says so', async () => {
    const inA: string[] = [];
    for (let i = 0; i < CAPACITY; i++) inA.push(await makeTicket(plantA));
    const inB = [await makeTicket(plantB), await makeTicket(plantB)];
    await suggest(inA);

    const dispatch = new BatchAssignmentService(prisma);
    await dispatch.dispatchForZone(zoneA, { dateFrom: DAY, dateTo: DAY, now: NOW });
    expect(await engineLoad()).toBe(CAPACITY);

    await suggest(inB);
    const second = await dispatch.dispatchForZone(zoneB, { dateFrom: DAY, dateTo: DAY, now: NOW });

    expect(second.tickets).toBe(0);
    expect(second.ticketSkips).toEqual(inB.map((ticketId) => ({ ticketId, reason: 'CAPACITY_REACHED' })));
    expect(await engineLoad()).toBe(CAPACITY);
  });

  it('AC2 — the surplus dropped is the work the engine ranked LAST, not an arbitrary slice', async () => {
    const offered: string[] = [];
    for (let i = 0; i < CAPACITY + 2; i++) offered.push(await makeTicket(plantA));
    await suggest(offered); // processingRank ascending, in offer order

    const summary = await new BatchAssignmentService(prisma).dispatchForZone(zoneA, {
      dateFrom: DAY,
      dateTo: DAY,
      now: NOW,
    });

    expect(summary.tickets).toBe(CAPACITY);
    // The claim is ordered by `processing_rank`, so the prefix that fits is the engine's own priority
    // order — a cap that dropped a random slice would silently reorder the engineer's day.
    expect(summary.ticketSkips).toEqual(offered.slice(CAPACITY).map((ticketId) => ({ ticketId, reason: 'CAPACITY_REACHED' })));
  });

  /** AC3 — the engine is bounded; a manager is not (#258 Q2). */
  it('AC3 — a manual assignment may still take the engineer past capacity', async () => {
    const inA: string[] = [];
    for (let i = 0; i < CAPACITY; i++) inA.push(await makeTicket(plantA));
    const extra = await makeTicket(plantA);
    await suggest(inA);
    await new BatchAssignmentService(prisma).dispatchForZone(zoneA, { dateFrom: DAY, dateTo: DAY, now: NOW });
    expect(await engineLoad()).toBe(CAPACITY);

    // A manager's own plan, written directly — the manual doors take no engineer lock and no capacity
    // check, deliberately, and #304 must not have quietly given them one.
    const schedule = await prisma.workSchedule.create({
      data: { seId: floatingSe, zoneId: zoneB, dateFrom: DAY, dateTo: DAY, status: 'ACTIVE', source: 'ZM_MANUAL' },
    });
    const batch = await prisma.plantBatchAssignment.create({
      data: { scheduleId: schedule.scheduleId, plantId: plantB, seId: floatingSe, status: 'OVERRIDDEN', stopSequence: 1 },
    });
    await prisma.batchAssignmentTicket.create({ data: { batchId: batch.batchId, ticketId: extra, sortOrder: 1 } });

    expect(await engineLoad()).toBe(CAPACITY + 1);
  });
});
