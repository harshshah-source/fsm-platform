import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { MeTicketsQueryService } from '../src/me-tickets/me-tickets-query.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { dispatchZoneLockKey } from '../src/scheduling/dispatch-zone-lock';
import { REMOVAL_REASONS } from '../src/scheduling/removal-reason';
import { alwaysClaims } from './support/tick-claims';
import { ScheduleClosureScheduler } from '../src/scheduling/schedule-closure-scheduler.service';
import { SeCoverageService } from '../src/shared-pool/se-coverage.service';

/**
 * #242 — an unresolved assignment recycles when its day plan closes.
 *
 * The bug this closes is a **double limbo**, and it is structural rather than occasional. Closure
 * flipped `work_schedules.status` to PARTIAL and touched nothing else, so a dispatched-but-unworked
 * ticket kept `removed_at NULL` and `assignment_state = FORMALLY_ASSIGNED` forever:
 *
 *   - invisible to the **scheduler**, because the recommender selects `OPEN` + `UNASSIGNED` only; and
 *   - invisible to the **SE**, because every day-plan read filters on a *live* schedule and that
 *     schedule is now terminal.
 *
 * So the ticket belonged to nobody and could never be assigned again — 4,983 OPEN tickets sat that way
 * in the dev mirror, and no ticket on the platform had ever reached a third assignment attempt.
 *
 * Two things about this sweep are worth stating because the tests below are shaped by them:
 *
 * **It cannot heal history.** `closeZone` selects `dateTo < today AND liveScheduleFilter()`, so a
 * schedule that has already flipped to PARTIAL is never selected again. The recycler lives inside that
 * method; it stops the bleeding from today forward and reaches nothing that has already bled (#243
 * owns the historical set — Option B, operator 2026-08-19).
 *
 * **It must not become a fan-out.** The method holds the zone's dispatch advisory lock, and a dispatch
 * that finds that lock held skips the zone for the whole run — leaving its SEs without a day plan. So
 * recycling is set-based statements over the closing set, and the "one instant on every row" assertion
 * below is what pins that: a per-ticket loop would stamp each row with its own `new Date()`.
 */
const NS = Date.now();

/** Closure runs at 04:00 IST on the 4th; every "yesterday" below is the 3rd. */
const NOW = new Date('2026-08-03T22:30:00Z'); // 04:00 IST on 2026-08-04
const TODAY = new Date(Date.UTC(2026, 7, 4));
const YESTERDAY = new Date(Date.UTC(2026, 7, 3));
const YESTERDAY_AT = new Date('2026-08-02T23:30:00Z'); // 05:00 IST on 2026-08-03
const TODAY_AT = new Date('2026-08-03T23:30:00Z'); // 05:00 IST on 2026-08-04

interface RowOverrides {
  removedAt?: Date;
  removedBy?: string | null;
  removalReason?: string;
  deferredToDate?: Date;
}

describe('#242 — unresolved assignments recycle at schedule closure', () => {
  let prisma: PrismaService;
  let closer: ScheduleClosureScheduler;
  let rec: RecommenderService;
  let dispatch: BatchAssignmentService;
  let meTickets: MeTicketsQueryService;

  let companyId: bigint;
  const zoneIds: bigint[] = [];
  const plantIds: bigint[] = [];
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];

  const makeZone = async (): Promise<bigint> => {
    const z = await prisma.zone.create({ data: { name: `Z-rcy-${NS}-${zoneIds.length}` } });
    zoneIds.push(z.zoneId);
    return z.zoneId;
  };

  const makePlant = async (zoneId: bigint): Promise<bigint> => {
    const p = await prisma.plant.create({ data: { name: `P-rcy-${NS}-${plantIds.length}`, zoneId } });
    plantIds.push(p.plantId);
    return p.plantId;
  };

  /** An SE who covers `plantId` — dedicated, so the recommender can actually pick them. */
  const makeSe = async (zoneId: bigint, plantId: bigint, dailyCapacity = 10): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@rcy.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({
      data: { engineerId: u.userId, coverageType: 'DEDICATED', zoneId, dailyCapacity },
    });
    await prisma.seCoverage.create({ data: { seId: u.userId, plantId, coverageType: 'DEDICATED' } });
    return u.userId;
  };

  /** A rankable TROUBLESHOOT ticket (device state carries the SLA bucket the canonical sort needs). */
  const makeTicket = async (
    plantId: bigint,
    status: 'OPEN' | 'SUBMITTED' | 'CLOSED' | 'CLOSED_AUTO_RECOVERY',
    assignmentState: 'UNASSIGNED' | 'FORMALLY_ASSIGNED' = 'FORMALLY_ASSIGNED',
    deferredUntil: Date | null = null,
  ): Promise<string> => {
    const deviceId = String(13_400_000_000 + (NS % 100_000) * 20 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        hasOpenFailureCycle: true,
        latestGpsDatetime: new Date(YESTERDAY_AT.getTime() - 180 * 60_000),
        plantId,
        companyId,
        computedAt: YESTERDAY_AT,
      },
    });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: YESTERDAY_AT } });
    const t = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status,
        assignmentState,
        deferredUntil,
        failureCycleId: cycle.cycleId,
        deviceId,
        plantId,
        companyId,
        companyTier: 'GOLD',
        lastStateChangedAt: YESTERDAY_AT,
      },
    });
    ticketIds.push(t.ticketId);
    return t.ticketId;
  };

  /** A hand-built day plan: schedule → one batch → one row per ticket, overrides applied verbatim. */
  const makeSchedule = async (
    zoneId: bigint,
    plantId: bigint,
    seId: string,
    day: Date,
    status: 'ACTIVE' | 'OVERRIDDEN',
    rows: { ticketId: string; overrides?: RowOverrides }[],
  ): Promise<bigint> => {
    const schedule = await prisma.workSchedule.create({
      data: { seId, zoneId, dateFrom: day, dateTo: day, status, source: 'SYSTEM_GENERATED', dispatchedAt: day },
    });
    const batch = await prisma.plantBatchAssignment.create({
      data: { scheduleId: schedule.scheduleId, plantId, seId, status: 'AUTO_ASSIGNED', stopSequence: 1 },
    });
    let sortOrder = 1;
    for (const { ticketId, overrides } of rows) {
      await prisma.batchAssignmentTicket.create({
        data: { batchId: batch.batchId, ticketId, sortOrder: sortOrder++, ...overrides },
      });
    }
    return schedule.scheduleId;
  };

  const rowsFor = (ticketId: string) =>
    prisma.batchAssignmentTicket.findMany({ where: { ticketId }, orderBy: { id: 'asc' } });
  const liveRows = (ticketId: string) =>
    prisma.batchAssignmentTicket.findMany({ where: { ticketId, removedAt: null } });
  const ticketOf = (ticketId: string) => prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
  const statusOf = async (scheduleId: bigint): Promise<string> =>
    (await prisma.workSchedule.findUniqueOrThrow({ where: { scheduleId }, select: { status: true } })).status;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    closer = new ScheduleClosureScheduler(prisma, alwaysClaims(), { enabled: true });
    rec = new RecommenderService(prisma, new CandidateSelectionService(prisma));
    dispatch = new BatchAssignmentService(prisma);
    meTickets = new MeTicketsQueryService(prisma, new SeCoverageService(prisma));

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

    companyId = (
      await prisma.company.create({ data: { name: 'Co-rcy-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
  });

  afterAll(async () => {
    await prisma.dispatchDecisionTrace.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    const schedules = await prisma.workSchedule.findMany({
      where: { zoneId: { in: zoneIds } },
      select: { scheduleId: true },
    });
    const batches = await prisma.plantBatchAssignment.findMany({
      where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } },
      select: { batchId: true },
    });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.workSchedule.deleteMany({ where: { zoneId: { in: zoneIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seCoverage.deleteMany({ where: { seId: { in: userIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: plantIds } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: zoneIds } } });
    await prisma.onModuleDestroy();
  });

  /**
   * AC-1, end to end and through the real dispatcher rather than a hand-built fixture: the whole point
   * of the slice is that a **second** attempt becomes possible, and only the real recommender can
   * demonstrate that it now selects a ticket it previously could not see.
   */
  it('AC-1: a ticket left unworked yesterday is recycled and dispatched again today', async () => {
    const zoneId = await makeZone();
    const plantId = await makePlant(zoneId);
    const se = await makeSe(zoneId, plantId);
    const ticketId = await makeTicket(plantId, 'OPEN', 'UNASSIGNED');

    // Yesterday's plan, built by the real pipeline. Attempt #1.
    await rec.runForZone(zoneId, { now: YESTERDAY_AT });
    await dispatch.dispatchForZone(zoneId, { dateFrom: YESTERDAY, dateTo: YESTERDAY, now: YESTERDAY_AT });
    expect(await liveRows(ticketId)).toHaveLength(1);
    expect((await ticketOf(ticketId)).assignmentState).toBe('FORMALLY_ASSIGNED');

    // The SE never worked it. Closure runs at 04:00 IST.
    await closer.closeTick({ now: NOW });

    const [attemptOne] = await rowsFor(ticketId);
    expect(attemptOne.removedAt).not.toBeNull();
    expect(attemptOne.removalReason).toBe(REMOVAL_REASONS.PLAN_EXPIRED);
    // A NULL actor is the whole signature of a system recycle — with #241's reason column beside it,
    // "who" and "why" are finally separable.
    expect(attemptOne.removedBy).toBeNull();
    expect((await ticketOf(ticketId)).assignmentState).toBe('UNASSIGNED');

    // Attempt #2 — the thing that had never happened on this platform.
    await rec.runForZone(zoneId, { now: TODAY_AT });
    const out = await dispatch.dispatchForZone(zoneId, { dateFrom: TODAY, dateTo: TODAY, now: TODAY_AT });

    expect(out.tickets).toBe(1);
    expect(await rowsFor(ticketId)).toHaveLength(2);
    expect(await liveRows(ticketId)).toHaveLength(1);
    expect((await ticketOf(ticketId)).assignmentState).toBe('FORMALLY_ASSIGNED');
    expect(se).toBeTruthy();
  });

  /** AC-5 — release volume is never silent: the tick says how many tickets it put back. */
  it('AC-5: the closure outcome reports the recycled count', async () => {
    const zoneId = await makeZone();
    const plantId = await makePlant(zoneId);
    const se = await makeSe(zoneId, plantId);
    const a = await makeTicket(plantId, 'OPEN');
    const b = await makeTicket(plantId, 'OPEN');
    await makeSchedule(zoneId, plantId, se, YESTERDAY, 'ACTIVE', [{ ticketId: a }, { ticketId: b }]);

    const outcome = await closer.closeTick({ now: NOW });

    expect(outcome).toMatchObject({ ran: true });
    if (!outcome.ran) throw new Error('unreachable');
    expect(outcome.recycled).toBeGreaterThanOrEqual(2);
  });

  /**
   * AC-3, the half that cannot be read off the source: **one statement, not a loop**. Every row the
   * sweep stamps in a zone carries the identical `removed_at`, which a per-ticket fan-out (each row
   * taking its own `new Date()`) could not produce. This is the lock-window guarantee expressed as a
   * fact about the data rather than as a comment.
   */
  it('AC-3: the whole closing set is stamped by set-based statements — one instant on every row', async () => {
    const zoneId = await makeZone();
    const plantId = await makePlant(zoneId);
    const seOne = await makeSe(zoneId, plantId);
    const seTwo = await makeSe(zoneId, plantId);
    const seThree = await makeSe(zoneId, plantId);
    const batchOf = async (se: string): Promise<string[]> => {
      const ids = [await makeTicket(plantId, 'OPEN'), await makeTicket(plantId, 'OPEN')];
      await makeSchedule(zoneId, plantId, se, YESTERDAY, 'ACTIVE', ids.map((ticketId) => ({ ticketId })));
      return ids;
    };
    const ids = [...(await batchOf(seOne)), ...(await batchOf(seTwo)), ...(await batchOf(seThree))];

    await closer.closeTick({ now: NOW });

    const stamped = await prisma.batchAssignmentTicket.findMany({ where: { ticketId: { in: ids } } });
    expect(stamped).toHaveLength(6);
    const instants = new Set(stamped.map((r) => r.removedAt?.toISOString()));
    expect(instants.size).toBe(1);
    expect([...instants][0]).toBeDefined();
    expect(stamped.every((r) => r.removalReason === REMOVAL_REASONS.PLAN_EXPIRED)).toBe(true);
  });

  /** AC-3 — a second tick matches nothing: `removed_at IS NULL` is the idempotency guard. */
  it('AC-3: recycling is idempotent — a second tick is a no-op', async () => {
    const zoneId = await makeZone();
    const plantId = await makePlant(zoneId);
    const se = await makeSe(zoneId, plantId);
    const ticketId = await makeTicket(plantId, 'OPEN');
    await makeSchedule(zoneId, plantId, se, YESTERDAY, 'ACTIVE', [{ ticketId }]);

    await closer.closeTick({ now: NOW });
    const [first] = await rowsFor(ticketId);

    const second = await closer.closeTick({ now: new Date(NOW.getTime() + 60_000) });

    const [after] = await rowsFor(ticketId);
    expect(after.removedAt?.toISOString()).toBe(first.removedAt?.toISOString());
    expect(after.removalReason).toBe(REMOVAL_REASONS.PLAN_EXPIRED);
    expect(second).toMatchObject({ ran: true, recycled: 0 });
  });

  /**
   * The lock is the reason this sweep is written the way it is, so it is asserted for the *recycling*
   * and not only for the status flip: a zone mid-dispatch must come out of the tick completely
   * untouched, row and ticket alike.
   */
  it('AC-3: a zone whose dispatch holds the lock is not recycled at all', async () => {
    const zoneId = await makeZone();
    const plantId = await makePlant(zoneId);
    const se = await makeSe(zoneId, plantId);
    const ticketId = await makeTicket(plantId, 'OPEN');
    const scheduleId = await makeSchedule(zoneId, plantId, se, YESTERDAY, 'ACTIVE', [{ ticketId }]);

    const holder = new PrismaService();
    await holder.onModuleInit();
    let release!: () => void;
    const releasable = new Promise<void>((r) => (release = r));
    let taken!: () => void;
    const lockTaken = new Promise<void>((r) => (taken = r));
    const holding = holder.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT true AS held FROM pg_advisory_xact_lock(hashtext(${dispatchZoneLockKey(zoneId)}))`;
        taken();
        await releasable;
      },
      { timeout: 60_000 },
    );

    try {
      await lockTaken;
      await closer.closeTick({ now: NOW });

      expect(await liveRows(ticketId)).toHaveLength(1);
      expect((await ticketOf(ticketId)).assignmentState).toBe('FORMALLY_ASSIGNED');
      expect(await statusOf(scheduleId)).toBe('ACTIVE');
    } finally {
      release();
      await holding;
      await holder.onModuleDestroy();
    }

    // The backstop catches up — skipping is a deferral, not an abandonment.
    await closer.closeTick({ now: NOW });
    expect(await liveRows(ticketId)).toHaveLength(0);
  });

  /**
   * Protected class 1 — a **resolved** ticket. Its row is stamped so the #241 leak cannot reopen (every
   * day-plan read filters `removed_at IS NULL` and not ticket status), but the ticket is deliberately
   * NOT unassigned: it is finished, and returning finished work to the pool is the one thing a recycler
   * must never do.
   */
  it('protected: a resolved ticket is backstop-stamped RESOLVED_AT_CLOSURE and never unassigned', async () => {
    const zoneId = await makeZone();
    const plantId = await makePlant(zoneId);
    const se = await makeSe(zoneId, plantId);
    const ticketId = await makeTicket(plantId, 'CLOSED');
    await makeSchedule(zoneId, plantId, se, YESTERDAY, 'ACTIVE', [{ ticketId }]);

    await closer.closeTick({ now: NOW });

    const [row] = await rowsFor(ticketId);
    expect(row.removedAt).not.toBeNull();
    expect(row.removalReason).toBe(REMOVAL_REASONS.RESOLVED_AT_CLOSURE);
    expect((await ticketOf(ticketId)).assignmentState).toBe('FORMALLY_ASSIGNED');
  });

  /** Protected class 2 — a ZM withdrawal. Already `removed_at IS NOT NULL`, so outside the filter;
   *  its actor and its reason both survive, because overwriting them would rewrite the ZM's account. */
  it('protected: a human withdrawal keeps its actor and its reason', async () => {
    const zoneId = await makeZone();
    const plantId = await makePlant(zoneId);
    const se = await makeSe(zoneId, plantId);
    const ticketId = await makeTicket(plantId, 'OPEN', 'UNASSIGNED');
    const removedAt = new Date('2026-08-03T10:00:00Z');
    await makeSchedule(zoneId, plantId, se, YESTERDAY, 'OVERRIDDEN', [
      { ticketId, overrides: { removedAt, removedBy: se, removalReason: REMOVAL_REASONS.ZM_WITHDRAWN } },
    ]);

    await closer.closeTick({ now: NOW });

    const [row] = await rowsFor(ticketId);
    expect(row.removedAt?.toISOString()).toBe(removedAt.toISOString());
    expect(row.removedBy).toBe(se);
    expect(row.removalReason).toBe(REMOVAL_REASONS.ZM_WITHDRAWN);
  });

  /** Protected class 3 — auto-recovery. Doubly excluded: resolved status AND an already-stamped row. */
  it('protected: an auto-recovered ticket keeps its AUTO_RECOVERY stamp', async () => {
    const zoneId = await makeZone();
    const plantId = await makePlant(zoneId);
    const se = await makeSe(zoneId, plantId);
    const ticketId = await makeTicket(plantId, 'CLOSED_AUTO_RECOVERY', 'UNASSIGNED');
    const removedAt = new Date('2026-08-03T11:00:00Z');
    await makeSchedule(zoneId, plantId, se, YESTERDAY, 'ACTIVE', [
      { ticketId, overrides: { removedAt, removedBy: null, removalReason: REMOVAL_REASONS.AUTO_RECOVERY } },
    ]);

    await closer.closeTick({ now: NOW });

    const [row] = await rowsFor(ticketId);
    expect(row.removedAt?.toISOString()).toBe(removedAt.toISOString());
    expect(row.removalReason).toBe(REMOVAL_REASONS.AUTO_RECOVERY);
  });

  /**
   * Protected class 4/5 — the ticket moved. The source row on yesterday's plan was already stamped
   * REASSIGNED; the ticket's real, live assignment sits on **today's** schedule and must survive the
   * tick untouched, because that plan has not closed. (The partial unique
   * `batch_assignment_tickets_one_active_per_ticket` is what makes "the stamped row was its only live
   * assignment" a database fact rather than an assumption.)
   */
  it('protected: a reassigned ticket keeps its live row on the still-open destination plan', async () => {
    const zoneId = await makeZone();
    const plantId = await makePlant(zoneId);
    const from = await makeSe(zoneId, plantId);
    const to = await makeSe(zoneId, plantId);
    const ticketId = await makeTicket(plantId, 'OPEN');
    const removedAt = new Date('2026-08-03T12:00:00Z');
    await makeSchedule(zoneId, plantId, from, YESTERDAY, 'OVERRIDDEN', [
      { ticketId, overrides: { removedAt, removedBy: from, removalReason: REMOVAL_REASONS.REASSIGNED } },
    ]);
    const destination = await makeSchedule(zoneId, plantId, to, TODAY, 'ACTIVE', [{ ticketId }]);

    await closer.closeTick({ now: NOW });

    const rows = await rowsFor(ticketId);
    expect(rows[0].removalReason).toBe(REMOVAL_REASONS.REASSIGNED);
    expect(await liveRows(ticketId)).toHaveLength(1);
    expect((await ticketOf(ticketId)).assignmentState).toBe('FORMALLY_ASSIGNED');
    expect(await statusOf(destination)).toBe('ACTIVE');
  });

  /**
   * Protected class 6 — a return-date deferral (#246). Its row was removed at filing with
   * VEHICLE_UNAVAILABLE, which is what makes the window countable by #244 as *reached but
   * unsuccessful*; a recycler that restamped it would silently reclassify a field visit as an expired
   * plan. The deferral date must also survive — that is AC-4 on a row that already has one.
   */
  it('protected: a vehicle-unavailable deferral keeps its reason and its return date', async () => {
    const zoneId = await makeZone();
    const plantId = await makePlant(zoneId);
    const se = await makeSe(zoneId, plantId);
    const returnDate = new Date(Date.UTC(2026, 7, 12));
    const ticketId = await makeTicket(plantId, 'OPEN', 'UNASSIGNED', returnDate);
    const removedAt = new Date('2026-08-03T13:00:00Z');
    await makeSchedule(zoneId, plantId, se, YESTERDAY, 'ACTIVE', [
      { ticketId, overrides: { removedAt, removedBy: se, removalReason: REMOVAL_REASONS.VEHICLE_UNAVAILABLE } },
    ]);

    await closer.closeTick({ now: NOW });

    const [row] = await rowsFor(ticketId);
    expect(row.removalReason).toBe(REMOVAL_REASONS.VEHICLE_UNAVAILABLE);
    expect((await ticketOf(ticketId)).deferredUntil?.toISOString()).toBe(returnDate.toISOString());
  });

  /**
   * AC-4 on the recycling path itself: the sweep writes `assignment_state` and never `deferred_until`.
   * A ticket that carries a future return date AND a live row (a manager moved the date forward after
   * the SE's report, say) must come out of the tick recycled *and still waiting* — otherwise the sweep
   * would hand a ticket whose vehicle is provably absent straight back to tomorrow's dispatch.
   */
  it('AC-4: recycling never writes deferredUntil — a deferred-then-recycled history keeps its date', async () => {
    const zoneId = await makeZone();
    const plantId = await makePlant(zoneId);
    const se = await makeSe(zoneId, plantId);
    const returnDate = new Date(Date.UTC(2026, 7, 20));
    const ticketId = await makeTicket(plantId, 'OPEN', 'FORMALLY_ASSIGNED', returnDate);
    await makeSchedule(zoneId, plantId, se, YESTERDAY, 'ACTIVE', [{ ticketId }]);

    await closer.closeTick({ now: NOW });

    const [row] = await rowsFor(ticketId);
    expect(row.removalReason).toBe(REMOVAL_REASONS.PLAN_EXPIRED);
    const t = await ticketOf(ticketId);
    expect(t.assignmentState).toBe('UNASSIGNED');
    expect(t.deferredUntil?.toISOString()).toBe(returnDate.toISOString());
  });

  /**
   * Capacity. `committedDayLoad` seeds the per-SE counter from live rows on **live** schedules covering
   * the target day, so yesterday's closed plan was already excluded and the stamps cannot change the
   * figure. Asserted behaviourally, at a capacity of 1, because that is where an off-by-one would show:
   * an SE whose yesterday still counted could never be given today's ticket.
   */
  it('capacity: yesterday\'s recycled stamps do not consume today\'s capacity', async () => {
    const zoneId = await makeZone();
    const plantId = await makePlant(zoneId);
    const se = await makeSe(zoneId, plantId, 1);
    const stale = await makeTicket(plantId, 'OPEN');
    await makeSchedule(zoneId, plantId, se, YESTERDAY, 'ACTIVE', [{ ticketId: stale }]);

    await closer.closeTick({ now: NOW });

    await rec.runForZone(zoneId, { now: TODAY_AT });
    const out = await dispatch.dispatchForZone(zoneId, { dateFrom: TODAY, dateTo: TODAY, now: TODAY_AT });

    // The recycled ticket is the only unassigned work in the zone, and the SE's one slot is free.
    expect(out.tickets).toBe(1);
    expect(await liveRows(stale)).toHaveLength(1);
  });

  /**
   * AC-6 — the SE-facing half, and the transition is the assertion.
   *
   * `MeTicketsQueryService` picks the SE's newest **live** schedule with no date predicate of its own
   * (`me-tickets-query.service.ts:41`) — deliberately, since #147's closure is what makes a plan
   * terminal. So before the tick the ticket reads as an assigned plan item on a day that is over
   * (`assigned: true`, `PLAN`), and the moment closure lands it would, without recycling, fall out of
   * every branch at once: no live schedule, and still `FORMALLY_ASSIGNED` so the shared-pool branch
   * (`OPEN` + `UNASSIGNED` + not deferred + a covered plant) rejects it too. That is the double limbo.
   * Recycling turns the second branch on, which is the whole SE-visible consequence of the slice.
   */
  it('AC-6: a recycled ticket reappears on /me/tickets through the shared-pool branch', async () => {
    const zoneId = await makeZone();
    const plantId = await makePlant(zoneId);
    const se = await makeSe(zoneId, plantId);
    const ticketId = await makeTicket(plantId, 'OPEN');
    await makeSchedule(zoneId, plantId, se, YESTERDAY, 'ACTIVE', [{ ticketId }]);

    const before = await meTickets.getMyTickets(se, TODAY_AT);
    expect(before.items.find((t) => t.ticketId === ticketId)).toMatchObject({ assigned: true, workState: 'PLAN' });

    await closer.closeTick({ now: NOW });

    const after = await meTickets.getMyTickets(se, TODAY_AT);
    const row = after.items.find((t) => t.ticketId === ticketId);
    expect(row).toBeDefined();
    expect(row?.assigned).toBe(false);
    expect(row?.workState).toBe('VISIT_NOW');
  });

  /**
   * The table-wide invariant #241 established, re-asserted after this slice has run: the sweep is a new
   * writer of `removed_at`, and a writer that forgets its reason reopens exactly the hole #241 closed.
   * Scoped to the whole table on purpose — the fixture-scoped version would pass for a future writer
   * that never touches these rows.
   */
  it('every row this slice removed carries a reason, table-wide', async () => {
    const orphans = await prisma.batchAssignmentTicket.count({
      where: { removedAt: { not: null }, removalReason: null },
    });
    expect(orphans).toBe(0);
    const premature = await prisma.batchAssignmentTicket.count({
      where: { removedAt: null, removalReason: { not: null } },
    });
    expect(premature).toBe(0);
  });
});
