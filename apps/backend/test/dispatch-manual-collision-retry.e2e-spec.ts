import { randomUUID } from 'node:crypto';
import { istDate } from '../src/common/ist-day';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';

/**
 * #307 (forensics RC-8) — a colliding manual assign costs one ticket, not the SE's whole plan.
 *
 * A manager assigning ticket T inside a per-SE dispatch transaction's window — after the
 * already-assigned re-read, before the batch-ticket insert — trips the `batch_assignment_tickets`
 * partial unique. A P2002 aborts its interactive transaction (#265), so the SE landed in `seSkips`
 * and `clearFailedSeOrphans` retired **every** SUGGESTED row they had: one ticket somebody else took
 * silently discarded the engine's entire plan for that engineer, and recovery meant a human noticing
 * the zone card and pressing Run again.
 *
 * Bulk-unassign already checks the zone claim for exactly this reason; manual assigns deliberately do
 * not, and the fix must not make them start — an operator waiting on the engine inverts #258's
 * posture. So the engine retries the SE once instead.
 *
 * ## Staging the window
 *
 * The collision has to commit *inside* the transaction, which a hook before `$transaction` cannot do:
 * fired there, the idempotency re-read simply folds the ticket out and no P2002 ever happens — the
 * graceful path, not the one under test. So the transaction client itself is wrapped and the
 * competing insert fires immediately before the first `batchAssignmentTicket.create`, which is the
 * exact instant RC-8 describes.
 */
const NS = Date.now();

/** Wraps `tx.batchAssignmentTicket.create` so a competing write lands in the collision window. */
function collidingPrisma(
  prisma: PrismaService,
  collide: (ticketId: string) => Promise<unknown>,
  times = 1,
): PrismaService {
  let fired = 0;
  const wrapTx = (tx: object): object =>
    new Proxy(tx, {
      get(target, prop, receiver) {
        if (prop !== 'batchAssignmentTicket') return Reflect.get(target, prop, receiver);
        const delegate = Reflect.get(target, prop, receiver) as Record<string, unknown>;
        return new Proxy(delegate, {
          get(d, dp) {
            if (dp !== 'create') return Reflect.get(d, dp);
            return async (...args: unknown[]) => {
              if (fired < times) {
                fired += 1;
                // Collide on the ticket this insert is ABOUT to write, so the P2002 is guaranteed
                // regardless of which ticket the processing order puts first.
                await collide((args[0] as { data: { ticketId: string } }).data.ticketId);
              }
              return (d.create as (...a: unknown[]) => unknown)(...args);
            };
          },
        });
      },
    });

  return new Proxy(prisma, {
    get(target, prop, receiver) {
      if (prop === '$transaction') {
        return (fn: unknown, ...rest: unknown[]) => {
          const real = (target as unknown as Record<string, (...a: unknown[]) => unknown>).$transaction;
          if (typeof fn !== 'function') return real.call(target, fn, ...rest);
          return real.call(target, ((tx: object) => (fn as (t: object) => unknown)(wrapTx(tx))) as never, ...rest);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as PrismaService;
}

describe('#307 — a manual assign mid-dispatch costs one ticket, not the plan', () => {
  let prisma: PrismaService;
  let rec: RecommenderService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let seId: string;
  let manualSeId: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  const NOW = new Date('2026-06-21T06:00:00Z');
  const DAY = istDate(NOW);

  const makeTicket = async (gpsAgeMin: number): Promise<string> => {
    const deviceId = String(9_470_000_000 + (NS % 100_000) * 10 + deviceIds.length);
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
    ticketIds.push(ticket.ticketId);
    return ticket.ticketId;
  };

  /**
   * The manager's plan, created up front so the collision itself is ONE insert.
   *
   * That matters more than it looks. The competing write fires while the dispatch transaction is open,
   * and anything it touches that the transaction already holds deadlocks the test against the code
   * under test: the first draft also flipped `tickets.assignment_state`, a row #306's guarded update
   * had just locked, so the collision waited on the dispatch and the dispatch waited on the collision.
   * A manual assign's *effect* on the dispatch is entirely the `batch_assignment_tickets` unique, so
   * the insert alone stages it faithfully — and the manager's own ticket-status write, which in
   * production happens in their own transaction, is applied afterwards.
   */
  let manualBatchId: bigint;

  const collideOn = (ticketId: string) =>
    prisma.batchAssignmentTicket.create({ data: { batchId: manualBatchId, ticketId, sortOrder: 1 } });

  const liveBatchRows = (ticketId: string) =>
    prisma.batchAssignmentTicket.findMany({ where: { ticketId, removedAt: null } });

  const resetPlans = async (): Promise<void> => {
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
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    rec = new RecommenderService(prisma, new CandidateSelectionService(prisma));

    zoneId = (await prisma.zone.create({ data: { name: 'Z-307-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-307-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-307-' + NS, zoneId } })).plantId;

    for (const label of ['engine', 'manual']) {
      const tag = randomUUID().slice(0, 8);
      const u = await prisma.user.create({
        data: { name: `SE ${label} ${tag}`, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@d307.test`, zoneId },
      });
      userIds.push(u.userId);
      if (label === 'engine') {
        seId = u.userId;
        await prisma.engineerMaster.create({
          data: { engineerId: seId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 },
        });
        await prisma.seCoverage.create({ data: { seId, plantId, coverageType: 'DEDICATED' } });
      } else {
        manualSeId = u.userId;
        await prisma.engineerMaster.create({
          data: { engineerId: manualSeId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 0 },
        });
      }
    }
  });

  beforeEach(async () => {
    const schedule = await prisma.workSchedule.create({
      data: { seId: manualSeId, zoneId, dateFrom: DAY, dateTo: DAY, status: 'ACTIVE', source: 'ZM_MANUAL' },
    });
    manualBatchId = (
      await prisma.plantBatchAssignment.create({
        data: { scheduleId: schedule.scheduleId, plantId, seId: manualSeId, status: 'OVERRIDDEN', stopSequence: 1 },
      })
    ).batchId;
  });

  afterEach(async () => {
    await resetPlans();
    // Retire this case's tickets rather than resetting them to OPEN: the recommender would otherwise
    // fold every earlier case's tickets into the next case's plan, and "the rest of the plan" would
    // stop meaning what the assertion says it means.
    await prisma.ticket.updateMany({
      where: { ticketId: { in: ticketIds } },
      data: { status: 'CLOSED', assignmentState: 'UNASSIGNED', deferredUntil: null },
    });
  });

  afterAll(async () => {
    await resetPlans();
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.seCoverage.deleteMany({ where: { plantId } });
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

  it('AC1/AC2 — the SE still gets the rest of their plan; the collided ticket folds out as a named skip', async () => {
    const planned = [await makeTicket(180), await makeTicket(120), await makeTicket(60)];
    await rec.runForZone(zoneId, { now: NOW });

    const dispatch = new BatchAssignmentService(collidingPrisma(prisma, collideOn));
    const summary = await dispatch.dispatchForZone(zoneId, { dateFrom: DAY, dateTo: DAY, now: NOW });

    // AC1 — one ticket, not the plan. Before this the SE lost all three.
    expect(summary.seSkips).toBeUndefined();
    expect(summary.tickets).toBe(planned.length - 1);

    // AC2 — the ledger names exactly the ticket that was taken, and it is on the manual plan only.
    expect(summary.ticketSkips).toHaveLength(1);
    const collided = summary.ticketSkips![0].ticketId;
    expect(summary.ticketSkips![0].reason).toBe('ALREADY_ASSIGNED');
    expect(planned).toContain(collided);
    for (const ticketId of planned.filter((t) => t !== collided)) {
      expect(await liveBatchRows(ticketId)).toHaveLength(1);
    }
    const rows = await liveBatchRows(collided);
    expect(rows).toHaveLength(1);
    expect((await prisma.plantBatchAssignment.findUniqueOrThrow({ where: { batchId: rows[0].batchId } })).seId).toBe(
      manualSeId,
    );

    // …and the engine's own recommendations were NOT retired as orphans — the retry committed, so the
    // SE never entered `seSkips` and `clearFailedSeOrphans` never saw them.
    expect(summary.orphansCleared).toBeUndefined();
  });

  it('the retry budget is ONE — a second collision skips and names the SE exactly as before', async () => {
    await makeTicket(180);
    await makeTicket(120);
    await rec.runForZone(zoneId, { now: NOW });

    // Colliding on whatever the insert is about to write means the retry hits a FRESH collision rather
    // than the one it already folded out. After the budget, the failure is reported as it always was.
    let n = 0;
    const dispatch = new BatchAssignmentService(
      collidingPrisma(
        prisma,
        async (ticketId) => {
          n += 1;
          await collideOn(ticketId);
        },
        2,
      ),
    );
    const summary = await dispatch.dispatchForZone(zoneId, { dateFrom: DAY, dateTo: DAY, now: NOW });

    expect(n).toBe(2); // one original attempt + exactly one retry, never a loop
    expect(summary.seSkips).toHaveLength(1);
    expect(summary.seSkips?.[0]).toMatchObject({ seId, constraint: 'BatchAssignmentTicket' });
    expect(summary.seSkips?.[0].reason).toMatch(/TICKET_CONFLICT/);
  });

  it('AC3 — a failure that is not the ticket collision is skipped on the first attempt, never retried', async () => {
    await makeTicket(120);
    await rec.runForZone(zoneId, { now: NOW });

    // Retrying a lock timeout or a generic database error would turn a real failure into a loop, so
    // the retry is scoped to the discriminated unique. Counting the injections is the assertion: one
    // means it was not retried.
    let attempts = 0;
    const dispatch = new BatchAssignmentService(
      collidingPrisma(
        prisma,
        async () => {
          attempts += 1;
          throw new Error('lock timeout: another zone-wide operation held the lock');
        },
        5,
      ),
    );
    const summary = await dispatch.dispatchForZone(zoneId, { dateFrom: DAY, dateTo: DAY, now: NOW });

    expect(attempts).toBe(1);
    expect(summary.seSkips).toHaveLength(1);
    expect(summary.seSkips?.[0]).toMatchObject({ seId, constraint: null });
    expect(summary.seSkips?.[0].reason).toMatch(/ZONE_LOCK_TIMEOUT/);
  });
});
