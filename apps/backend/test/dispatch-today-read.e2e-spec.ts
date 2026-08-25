import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { DispatchTodayQueryService } from '../src/scheduling/dispatch-today-query.service';
import { LoggingDayPlanNotifier } from '../src/scheduling/day-plan-notifier';
import { OverrideService } from '../src/scheduling/override.service';

/**
 * #284 — the cockpit's one read.
 *
 * Two properties matter more than the shape. First, it is scoped to the **operating day**: the
 * existing `/schedules` read filters on live status alone and has no date predicate at all, so it
 * mixes today's plans with stale never-closed ones while every label above it promises "today"
 * (`zm-schedule-query.service.ts:98-110`). The cockpit must not inherit that, so the day predicate is
 * pinned here rather than trusted.
 *
 * Second, an engineer with **no** plan today is a row, not an omission: an empty lane is a fact the
 * deck has to show — it is how an operator sees who is free.
 */
const NS = Date.now();
const TODAY = new Date('2026-06-28T06:00:00Z');
const LAST_WEEK = new Date('2026-06-21T06:00:00Z');

describe('#284 — GET /dispatch/today', () => {
  let prisma: PrismaService;
  let svc: DispatchTodayQueryService;
  let override: OverrideService;

  let zoneId: bigint;
  let otherZoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let zmUserId: string;
  let busySe: string;
  let idleSe: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];

  const scope = () => ({ role: 'ZONAL_MANAGER', zoneId: Number(zoneId) });

  const makeSe = async (): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@p284.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({
      data: { engineerId: u.userId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 8 },
    });
    await prisma.seCoverage.create({ data: { seId: u.userId, plantId, coverageType: 'DEDICATED' } });
    return u.userId;
  };

  const makeTicket = async (): Promise<string> => {
    const deviceId = String(11_940_000_000 + ((NS + deviceIds.length) % 100_000) + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        hasOpenFailureCycle: true,
        latestGpsDatetime: new Date(TODAY.getTime() - 30 * 60 * 60_000),
        plantId,
        companyId,
        computedAt: TODAY,
      },
    });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: TODAY } });
    const t = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        failureCycleId: cycle.cycleId,
        deviceId,
        plantId,
        companyId,
        companyTier: 'GOLD',
        lastStateChangedAt: TODAY,
      },
    });
    ticketIds.push(t.ticketId);
    return t.ticketId;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    override = new OverrideService(prisma, new AuditService(prisma), new LoggingDayPlanNotifier());
    svc = new DispatchTodayQueryService(prisma);

    const zm = await prisma.user.create({
      data: { name: 'ZM ' + NS, role: 'ZONAL_MANAGER', phone: 'zm284-' + NS, email: `zm-${NS}@p284.test` },
    });
    zmUserId = zm.userId;
    userIds.push(zm.userId);
    zoneId = (await prisma.zone.create({ data: { name: 'Z-284-' + NS, zonalManagerUserId: zm.userId } })).zoneId;
    otherZoneId = (await prisma.zone.create({ data: { name: 'Z2-284-' + NS, zonalManagerUserId: zm.userId } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-284-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-284-' + NS, zoneId } })).plantId;

    busySe = await makeSe();
    idleSe = await makeSe();

    // Today's committed work for one engineer, written through the real manual path.
    const t1 = await makeTicket();
    const t2 = await makeTicket();
    for (const t of [t1, t2]) {
      const r = await override.assignTicket(
        t,
        busySe,
        scope(),
        { userId: zmUserId, role: 'ZONAL_MANAGER', actedAsRole: null },
        TODAY,
      );
      expect(r.result).toBe('OK');
    }

    // A stale plan from last week that was never closed — the exact shape `/schedules` conflates with
    // today. It must not appear in a read whose name is "today".
    const stale = await prisma.workSchedule.create({
      data: {
        seId: idleSe,
        zoneId,
        dateFrom: new Date('2026-06-21'),
        dateTo: new Date('2026-06-21'),
        status: 'ACTIVE',
        source: 'ZM_MANUAL',
        dispatchedAt: LAST_WEEK,
      },
    });
    const staleBatch = await prisma.plantBatchAssignment.create({
      data: { scheduleId: stale.scheduleId, plantId, seId: idleSe, status: 'AUTO_ASSIGNED', stopSequence: 1 },
    });
    const staleTicket = await makeTicket();
    await prisma.batchAssignmentTicket.create({
      data: { batchId: staleBatch.batchId, ticketId: staleTicket, sortOrder: 1 },
    });
  });

  afterAll(async () => {
    const schedules = await prisma.workSchedule.findMany({
      where: { zoneId: { in: [zoneId, otherZoneId] } },
      select: { scheduleId: true },
    });
    const batches = await prisma.plantBatchAssignment.findMany({
      where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } },
      select: { batchId: true },
    });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } } });
    await prisma.workSchedule.deleteMany({ where: { zoneId: { in: [zoneId, otherZoneId] } } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seCoverage.deleteMany({ where: { plantId } });
    await prisma.engineerMaster.deleteMany({ where: { zoneId } });
    await prisma.plant.deleteMany({ where: { zoneId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: [zoneId, otherZoneId] } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.onModuleDestroy();
  });

  it('AC1 — returns the zone, the IST operating day, and one lane per engineer', async () => {
    const view = await svc.today(scope(), { zoneId, now: TODAY });

    expect(view.operatingDay).toBe('2026-06-28');
    expect(view.zone.zoneId).toBe(String(zoneId));
    expect(view.engineers.map((e) => e.seId).sort()).toEqual([busySe, idleSe].sort());
  });

  it('AC2 — a stale never-closed plan from last week is absent', async () => {
    const view = await svc.today(scope(), { zoneId, now: TODAY });
    const idle = view.engineers.find((e) => e.seId === idleSe);

    // The stale schedule is ACTIVE and in this zone, so the existing `/schedules` read returns it.
    // Scoped to the operating day, it is simply not today's plan.
    expect(idle?.stops).toEqual([]);
  });

  it('AC3 — an engineer with no plan today is a row, not an omission', async () => {
    const view = await svc.today(scope(), { zoneId, now: TODAY });
    const idle = view.engineers.find((e) => e.seId === idleSe);

    expect(idle).toBeDefined();
    expect(idle?.committed).toBe(0);
    expect(idle?.dailyCapacity).toBe(8);
  });

  it('AC1 — stops carry persisted order, ticket provenance, and no fabricated time', async () => {
    const view = await svc.today(scope(), { zoneId, now: TODAY });
    const busy = view.engineers.find((e) => e.seId === busySe);

    expect(busy?.stops.length).toBe(1);
    const stop = busy!.stops[0];
    expect(stop.stopSequence).toBe(1);
    expect(stop.plantId).toBe(String(plantId));
    expect(stop.tickets.map((t) => t.sortOrder)).toEqual([1, 2]);
    // #283's provenance reaches the surface that renders the grammar.
    expect(stop.tickets.every((t) => t.addSource === 'MANUAL_ASSIGN')).toBe(true);
    // #258 Q6 / the design's "no fake clock": ordinal sequence only, never a time.
    expect(JSON.stringify(view)).not.toMatch(/"(eta|estimatedArrival|arrivalTime|durationMinutes)"/);
  });

  it('AC4 — committed load matches the engine-facing capacity read, engineer for engineer', async () => {
    const view = await svc.today(scope(), { zoneId, now: TODAY });
    const busy = view.engineers.find((e) => e.seId === busySe);

    // One definition of "committed" (#269 / #272 R9). Two tickets assigned above, both live today.
    expect(busy?.committed).toBe(2);
    expect(view.situation.placed).toBe(2);
  });

  it('AC5 — a ZM cannot read another zone', async () => {
    await expect(svc.today(scope(), { zoneId: otherZoneId, now: TODAY })).rejects.toThrow();
  });

  /**
   * #286 AC5 — the recovery state reaches the operator, or the bound is a secret.
   *
   * "The zone stops being retried" is only acceptable because somebody is told. A zone whose day was
   * lost, recovered, or abandoned after three attempts looks identical on this page to a zone that had
   * a quiet morning, and that is precisely the reading an operator would draw if nothing said otherwise.
   */
  describe('#286 — the crashed-zone recovery rail', () => {
    afterEach(async () => {
      await prisma.dispatchZoneRecovery.deleteMany({ where: { zoneId } });
    });

    it('is null on an ordinary day — a zone that never crashed says nothing', async () => {
      const view = await svc.today(scope(), { zoneId, now: TODAY });
      expect(view.recovery).toBeNull();
    });

    it('carries the state, the attempts and the reason once a zone has been marked', async () => {
      await prisma.dispatchZoneRecovery.create({
        data: {
          zoneId,
          businessDate: new Date(Date.UTC(2026, 5, 28)),
          state: 'EXHAUSTED',
          attempts: 3,
          markedAt: TODAY,
          lastAttemptAt: TODAY,
          lastError: 'the zone kept failing',
        },
      });

      const view = await svc.today(scope(), { zoneId, now: TODAY });

      expect(view.recovery).toMatchObject({ state: 'EXHAUSTED', attempts: 3, lastError: 'the zone kept failing' });
    });

    /** Yesterday's crash is not today's situation — the mark is read for the operating day only. */
    it("ignores another day's mark", async () => {
      await prisma.dispatchZoneRecovery.create({
        data: {
          zoneId,
          businessDate: new Date(Date.UTC(2026, 5, 27)),
          state: 'EXHAUSTED',
          attempts: 3,
          markedAt: LAST_WEEK,
        },
      });

      expect((await svc.today(scope(), { zoneId, now: TODAY })).recovery).toBeNull();
    });
  });
});
