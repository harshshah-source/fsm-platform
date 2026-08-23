import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { dispatchZoneLockKey } from '../src/scheduling/dispatch-zone-lock';
import { alwaysClaims } from './support/tick-claims';
import { ScheduleClosureScheduler } from '../src/scheduling/schedule-closure-scheduler.service';

/**
 * Issue 147 slice 2 — work schedules reach a terminal status.
 *
 * Nothing on the platform ever wrote a terminal `work_schedules.status`, so live schedules accreted
 * forever (190 across 64 SEs on the dev DB at the 07-28 measurement) and every one of them stayed
 * eligible to be served as somebody's day plan. The closer is a periodic backstop in the
 * `PlantEligibilityRefreshScheduler` mould: master-switch re-checked per tick, single-in-flight guard,
 * structured outcome, never throws out of the cron context.
 *
 * The race that matters is #127's APPEND: it reads then extends an existing schedule inside one
 * transaction, so a closer that flipped the status in between would strand freshly appended stops on a
 * closed plan. The closer therefore takes the same per-zone dispatch advisory lock the APPEND holds,
 * and skips the zone rather than waiting.
 */
const NS = Date.now();
const NOW = new Date('2026-08-04T03:00:00Z');
const TODAY = new Date('2026-08-04T00:00:00Z');
const YESTERDAY = new Date('2026-08-03T00:00:00Z');

describe('Issue 147 slice 2 — ScheduleClosureScheduler.closeTick', () => {
  let prisma: PrismaService;
  let closer: ScheduleClosureScheduler;

  let companyId: bigint;
  const zoneIds: bigint[] = [];
  const plantIds: bigint[] = [];
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  const scheduleIds: bigint[] = [];

  const makeZone = async (): Promise<bigint> => {
    const z = await prisma.zone.create({ data: { name: `Z-cl-${NS}-${zoneIds.length}` } });
    zoneIds.push(z.zoneId);
    return z.zoneId;
  };

  const makePlant = async (zoneId: bigint): Promise<bigint> => {
    const p = await prisma.plant.create({ data: { name: `P-cl-${NS}-${plantIds.length}`, zoneId } });
    plantIds.push(p.plantId);
    return p.plantId;
  };

  const makeSe = async (zoneId: bigint): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@close.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({
      data: { engineerId: u.userId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 },
    });
    return u.userId;
  };

  const makeTicket = async (plantId: bigint, status: 'OPEN' | 'CLOSED'): Promise<string> => {
    const deviceId = String(9_720_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
    const t = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status,
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

  /** A one-stop schedule covering exactly `day`, carrying one ticket in `ticketStatus`. */
  const makeSchedule = async (
    zoneId: bigint,
    plantId: bigint,
    seId: string,
    day: Date,
    status: 'ACTIVE' | 'OVERRIDDEN',
    ticketStatus: 'OPEN' | 'CLOSED',
  ): Promise<bigint> => {
    const schedule = await prisma.workSchedule.create({
      data: { seId, zoneId, dateFrom: day, dateTo: day, status, source: 'SYSTEM_GENERATED', dispatchedAt: day },
    });
    scheduleIds.push(schedule.scheduleId);
    const batch = await prisma.plantBatchAssignment.create({
      data: { scheduleId: schedule.scheduleId, plantId, seId, status: 'AUTO_ASSIGNED', stopSequence: 1 },
    });
    await prisma.batchAssignmentTicket.create({
      data: { batchId: batch.batchId, ticketId: await makeTicket(plantId, ticketStatus), sortOrder: 1 },
    });
    return schedule.scheduleId;
  };

  const statusOf = async (scheduleId: bigint): Promise<string> =>
    (await prisma.workSchedule.findUniqueOrThrow({ where: { scheduleId }, select: { status: true } })).status;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    closer = new ScheduleClosureScheduler(prisma, alwaysClaims(), { enabled: true });
    companyId = (
      await prisma.company.create({ data: { name: 'Co-cl-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
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
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: plantIds } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: zoneIds } } });
    await prisma.onModuleDestroy();
  });

  it('closes a past-dated schedule and leaves today\'s alone', async () => {
    const zoneId = await makeZone();
    const plantId = await makePlant(zoneId);
    const stale = await makeSchedule(zoneId, plantId, await makeSe(zoneId), YESTERDAY, 'ACTIVE', 'OPEN');
    const current = await makeSchedule(zoneId, plantId, await makeSe(zoneId), TODAY, 'ACTIVE', 'OPEN');

    const outcome = await closer.closeTick({ now: NOW });

    expect(outcome).toMatchObject({ ran: true });
    expect(await statusOf(stale)).not.toBe('ACTIVE');
    expect(await statusOf(current)).toBe('ACTIVE');
  });

  /**
   * #262 AC-6, closure half. Splitting the zone dispatch into per-SE transactions opens gaps between
   * them that the all-or-nothing transaction did not have, and the review asked which zone-shaping
   * operations could now land in one.
   *
   * Closure is safe **by data**, and this pins the reason rather than the conclusion: it targets
   * `dateTo < today` while dispatch writes today, so the two row sets are disjoint however they
   * interleave. Asserted with a dispatch run holding the zone claim and a live schedule for today
   * present — the closure runs, closes the past-dated schedule, and leaves today's untouched.
   */
  it('#262: closure interleaving is a no-op on today\u2019s schedules, even mid-dispatch', async () => {
    const zoneId = await makeZone();
    const plantId = await makePlant(zoneId);
    const stale = await makeSchedule(zoneId, plantId, await makeSe(zoneId), YESTERDAY, 'ACTIVE', 'OPEN');
    const today = await makeSchedule(zoneId, plantId, await makeSe(zoneId), TODAY, 'ACTIVE', 'OPEN');

    // A dispatch run owns this zone right now — mid-run, between two per-SE transactions, so it holds
    // the #259 claim and no advisory lock at all.
    const run = await prisma.dispatchRun.create({
      data: { trigger: 'CRON', status: 'RUNNING', startedAt: NOW, heartbeatAt: new Date(), configSnapshot: {} },
    });
    await prisma.dispatchRunZone.create({
      data: { runId: run.runId, zoneId, status: 'RUNNING', startedAt: NOW },
    });

    try {
      const outcome = await closer.closeTick({ now: NOW });
      expect(outcome).toMatchObject({ ran: true });

      // Today's schedule — the one the live dispatch is building — is untouched. That is the property
      // that makes closure safe to interleave, and it holds because of the date scope, not because of
      // any lock.
      expect(await statusOf(today)).toBe('ACTIVE');
      // The claim guard must not have made closure useless either: past-dated work still closes.
      expect(await statusOf(stale)).not.toBe('ACTIVE');
    } finally {
      await prisma.dispatchRunZone.deleteMany({ where: { runId: run.runId } });
      await prisma.dispatchRun.delete({ where: { runId: run.runId } });
    }
  });

  // AC#4 as an invariant rather than a count: after a tick, nothing live may remain past its dateTo.
  it('leaves no live schedule past its dateTo', async () => {
    const zoneId = await makeZone();
    const plantId = await makePlant(zoneId);
    await makeSchedule(zoneId, plantId, await makeSe(zoneId), YESTERDAY, 'ACTIVE', 'OPEN');

    await closer.closeTick({ now: NOW });

    const stragglers = await prisma.workSchedule.count({
      where: { dateTo: { lt: TODAY }, status: { in: ['ACTIVE', 'OVERRIDDEN'] } },
    });
    expect(stragglers).toBe(0);
  });

  // #153 widened "live" to include OVERRIDDEN, which grew the stale-serveable population — a ZM-touched
  // plan from last week is exactly the kind of row that has to reach a terminal state.
  it('closes a past-dated OVERRIDDEN schedule too', async () => {
    const zoneId = await makeZone();
    const plantId = await makePlant(zoneId);
    const overridden = await makeSchedule(zoneId, plantId, await makeSe(zoneId), YESTERDAY, 'OVERRIDDEN', 'OPEN');

    await closer.closeTick({ now: NOW });

    expect(await statusOf(overridden)).not.toBe('OVERRIDDEN');
  });

  // The workflow's terminal pair is COMPLETED | PARTIAL, so the closer has to say which — writing
  // COMPLETED over a day the SE never finished would report work that did not happen.
  it('records COMPLETED when the day\'s work is done and PARTIAL when it is not', async () => {
    const zoneId = await makeZone();
    const plantId = await makePlant(zoneId);
    const finished = await makeSchedule(zoneId, plantId, await makeSe(zoneId), YESTERDAY, 'ACTIVE', 'CLOSED');
    const unfinished = await makeSchedule(zoneId, plantId, await makeSe(zoneId), YESTERDAY, 'ACTIVE', 'OPEN');

    await closer.closeTick({ now: NOW });

    expect(await statusOf(finished)).toBe('COMPLETED');
    expect(await statusOf(unfinished)).toBe('PARTIAL');
  });

  it('is a no-op when the master switch is off', async () => {
    const zoneId = await makeZone();
    const plantId = await makePlant(zoneId);
    const stale = await makeSchedule(zoneId, plantId, await makeSe(zoneId), YESTERDAY, 'ACTIVE', 'OPEN');

    const off = new ScheduleClosureScheduler(prisma, alwaysClaims(), { enabled: false });
    expect(await off.closeTick({ now: NOW })).toEqual({ ran: false, reason: 'DISABLED' });
    expect(await statusOf(stale)).toBe('ACTIVE');

    await closer.closeTick({ now: NOW }); // leave the DB clean for the invariant assertions above
  });

  // The APPEND race. A dispatch transaction holds `dispatch_zone_<id>` for its whole life; the closer
  // must not be able to flip a status underneath it. Held from a second connection so the contention is
  // real rather than simulated, and released only once the tick has been observed to skip.
  it('cannot close a schedule in a zone whose dispatch lock is held', async () => {
    const zoneId = await makeZone();
    const plantId = await makePlant(zoneId);
    const stale = await makeSchedule(zoneId, plantId, await makeSe(zoneId), YESTERDAY, 'ACTIVE', 'OPEN');

    const holder = new PrismaService();
    await holder.onModuleInit();
    let release!: () => void;
    const releasable = new Promise<void>((r) => (release = r));
    let taken!: () => void;
    const lockTaken = new Promise<void>((r) => (taken = r));

    const holding = holder.$transaction(
      async (tx) => {
        // Called as a FROM item: `pg_advisory_xact_lock` returns `void`, which the driver cannot
        // deserialize as a column, so the lock is taken and a real column is projected beside it.
        await tx.$queryRaw`SELECT true AS held FROM pg_advisory_xact_lock(hashtext(${dispatchZoneLockKey(zoneId)}))`;
        taken();
        await releasable;
      },
      { timeout: 60_000 },
    );

    try {
      await lockTaken;

      const blocked = await closer.closeTick({ now: NOW });

      expect(blocked).toMatchObject({ ran: true, zonesSkipped: 1 });
      expect(await statusOf(stale)).toBe('ACTIVE'); // the APPEND's schedule survived the tick
    } finally {
      release();
      await holding;
      await holder.onModuleDestroy();
    }

    // Once the dispatch transaction is gone the backstop catches up on the next tick — the zone is
    // skipped, never abandoned.
    await closer.closeTick({ now: NOW });
    expect(await statusOf(stale)).toBe('PARTIAL');
  });
});
