import { randomUUID } from 'node:crypto';
import { istDate } from '../src/common/ist-day';
import { PrismaService } from '../src/prisma/prisma.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { DayPlanQueryService } from '../src/scheduling/day-plan-query.service';
import { LoggingDayPlanNotifier } from '../src/scheduling/day-plan-notifier';

/**
 * #321 (forensics CB-8) — the two numbers in a `DAY_PLAN_DISPATCHED` notification share one basis.
 *
 * On a same-day append the payload mixed them: `stops` continued from the plan's existing maximum
 * (cumulative) while `tickets` counted only the rows this run wrote (incremental), so an SE with three
 * stops receiving one more stop of two tickets was told `stops=4, tickets=2`. Read together — and they
 * are only ever read together — those describe no state the plan was ever in.
 *
 * The basis chosen is **cumulative**, and the reason is testable rather than stylistic: the
 * notification's own body is "Your Day Plan is live. Tap to start.", and what the tap opens is the SE's
 * whole day plan. A count the SE can contradict by looking at the screen the notification sent them to
 * is worse than either basis on its own, so these cases assert the payload against
 * {@link DayPlanQueryService} — the read that renders Home — not against a hand-computed number.
 */
const NS = Date.now();

describe('#321 — day-plan notification counts agree', () => {
  let prisma: PrismaService;
  let dispatch: BatchAssignmentService;
  let dayPlan: DayPlanQueryService;

  let zoneId: bigint;
  let companyId: bigint;
  const plantIds: bigint[] = [];
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  const runIds: bigint[] = [];

  const NOW = new Date('2026-06-23T06:00:00Z');
  const DAY = istDate(NOW);

  const makeSe = async (label: string): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: `SE ${label} ${tag}`, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@o321.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({
      data: { engineerId: u.userId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 20 },
    });
    return u.userId;
  };

  const makeTicket = async (plantId: bigint): Promise<string> => {
    const deviceId = String(11_000_000_000 + (NS % 100_000) * 100 + deviceIds.length);
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

  const newRun = async (): Promise<bigint> => {
    const run = await prisma.dispatchRun.create({
      data: { trigger: 'MANUAL', status: 'RUNNING', startedAt: NOW, configSnapshot: {} },
    });
    runIds.push(run.runId);
    return run.runId;
  };

  /** One SUGGESTED recommendation per ticket, in the order given — the engine's canonical input. */
  const suggest = async (seId: string, runId: bigint, tickets: string[]): Promise<void> => {
    let rank = 0;
    for (const ticketId of tickets) {
      rank++;
      await prisma.recommendation.create({
        data: { ticketId, seId, status: 'SUGGESTED', path: 'MORNING_BATCH', scoreBreakdown: {}, processingRank: rank, runId },
      });
    }
  };

  /** Every `DAY_PLAN_DISPATCHED` payload this SE has been sent, oldest first. */
  const dispatchedPayloads = async (seId: string): Promise<{ stops: number; tickets: number }[]> => {
    const rows = await prisma.dayPlanNotificationOutbox.findMany({
      where: { seId, eventType: 'DAY_PLAN_DISPATCHED' },
      orderBy: { id: 'asc' },
      select: { payload: true },
    });
    return rows.map((r) => r.payload as unknown as { stops: number; tickets: number });
  };

  /** What Home will actually show this SE: live stops, and the live tickets across them. */
  const onScreen = async (seId: string): Promise<{ stops: number; tickets: number }> => {
    const plan = await dayPlan.getDayPlan(seId, { now: NOW });
    return { stops: plan.stops.length, tickets: plan.stops.reduce((n, s) => n + s.tickets.length, 0) };
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    dispatch = new BatchAssignmentService(prisma, new LoggingDayPlanNotifier());
    dayPlan = new DayPlanQueryService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-321-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-321-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    for (let i = 0; i < 3; i++) {
      plantIds.push((await prisma.plant.create({ data: { name: `P${i}-321-` + NS, zoneId } })).plantId);
    }
  });

  afterAll(async () => {
    const schedules = await prisma.workSchedule.findMany({ where: { zoneId }, select: { scheduleId: true } });
    const batches = await prisma.plantBatchAssignment.findMany({
      where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } },
      select: { batchId: true },
    });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.dayPlanNotificationOutbox.deleteMany({
      where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } },
    });
    await prisma.workSchedule.deleteMany({ where: { zoneId } });
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: plantIds } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.dispatchRun.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('AC2 — a fresh plan notifies exactly what it created', async () => {
    const se = await makeSe('fresh');
    const runId = await newRun();
    await suggest(se, runId, [await makeTicket(plantIds[0]), await makeTicket(plantIds[0]), await makeTicket(plantIds[1])]);

    const out = await dispatch.dispatchForZone(zoneId, { dateFrom: DAY, dateTo: DAY, now: NOW, runId });
    expect(out.tickets).toBe(3);

    // Two plants → two stops, three tickets. On a fresh plan the two bases coincide, which is why this
    // case is the one that must stay byte-identical (AC2) whichever basis the append case adopts.
    expect(await dispatchedPayloads(se)).toEqual([{ stops: 2, tickets: 3 }]);
    expect(await onScreen(se)).toEqual({ stops: 2, tickets: 3 });
  }, 30_000);

  it('AC1 — an append notifies the whole plan, not a stop total against a fresh-ticket count', async () => {
    const se = await makeSe('append');
    const firstRun = await newRun();
    await suggest(se, firstRun, [await makeTicket(plantIds[0]), await makeTicket(plantIds[0]), await makeTicket(plantIds[1])]);
    const first = await dispatch.dispatchForZone(zoneId, { dateFrom: DAY, dateTo: DAY, now: NOW, runId: firstRun });
    expect(first.tickets).toBe(3);

    // The append: one new plant, two new tickets, onto the plan the SE is already executing.
    const secondRun = await newRun();
    await suggest(se, secondRun, [await makeTicket(plantIds[2]), await makeTicket(plantIds[2])]);
    const second = await dispatch.dispatchForZone(zoneId, { dateFrom: DAY, dateTo: DAY, now: NOW, runId: secondRun });
    expect(second.schedules).toBe(1); // appended to the existing plan, not a second one
    expect(second.tickets).toBe(2);

    const payloads = await dispatchedPayloads(se);
    expect(payloads).toHaveLength(2);
    // Before the fix the second payload was `{ stops: 3, tickets: 2 }` — the stop count continued from
    // the plan's existing maximum while the ticket count restarted at this run's own rows, so the pair
    // described no state the plan had ever been in.
    expect(payloads[1]).toEqual({ stops: 3, tickets: 5 });

    // …and the basis is not asserted against a number computed here twice. It is asserted against the
    // read that renders Home, which is where the notification's own "Tap to start" sends the SE.
    expect(payloads[1]).toEqual(await onScreen(se));
  }, 30_000);

  it('the run ledger keeps counting its OWN tickets — the notification changed, the summary did not', async () => {
    const se = await makeSe('ledger');
    const firstRun = await newRun();
    await suggest(se, firstRun, [await makeTicket(plantIds[0])]);
    await dispatch.dispatchForZone(zoneId, { dateFrom: DAY, dateTo: DAY, now: NOW, runId: firstRun });

    const secondRun = await newRun();
    await suggest(se, secondRun, [await makeTicket(plantIds[1])]);
    const second = await dispatch.dispatchForZone(zoneId, { dateFrom: DAY, dateTo: DAY, now: NOW, runId: secondRun });

    // `DispatchSummary.tickets` feeds `dispatch_runs.tickets_dispatched` — "what did THIS run place?".
    // It is a different question from the one the notification answers and must stay incremental; a
    // cumulative summary would double-count the first run's ticket in the second run's ledger row.
    expect(second.tickets).toBe(1);
    expect(second.batches).toBe(1);
    expect((await dispatchedPayloads(se))[1]).toEqual({ stops: 2, tickets: 2 });
  }, 30_000);
});
