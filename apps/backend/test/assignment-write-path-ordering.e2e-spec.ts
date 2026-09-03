import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import { istDate } from '../src/common/ist-day';
import { isDeadlock } from '../src/common/lost-race';
import { PrismaService } from '../src/prisma/prisma.service';
import { LoggingDayPlanNotifier } from '../src/scheduling/day-plan-notifier';
import { OverrideService } from '../src/scheduling/override.service';
import { gate, hookedPrisma, isTicketLock, sleep, waitAtMost } from './support/tx-hooks';

/**
 * #327 (forensics RC-12 + RC-13) — the two manual assignment write paths acquire their rows in one
 * order, and stop numbers are minted under a lock rather than raced for.
 *
 * **RC-12.** `assignLane` locked the ticket row and *then* inserted the batch-ticket row;
 * `assignTicket` inserted the batch-ticket row and *then* updated the ticket. Two managers hitting one
 * ticket through the two doors therefore held each other's next row: Postgres broke the cycle with a
 * 40P01 that nothing caught, so one operator got a 500 from a condition the same file already answers
 * with a 409.
 *
 * **RC-13.** `nextStopSequence` / `nextSortOrder` are `max+1` reads with nothing serialising them, so
 * two adds landing on one schedule together minted the same stop number.
 *
 * ## Staging
 *
 * A deadlock is a property of *interleaving*, so every case here drives the interleaving explicitly
 * through a hooked transaction client rather than starting two calls and hoping. The harness moved to
 * `test/support/tx-hooks.ts` when #334 brought the dispatch run and the two-schedule movers onto the
 * same order and needed to stage the identical shape; the reasoning for the bounded waits lives there.
 */
const NS = Date.now();

describe('#327 — one acquisition order across the manual assignment write paths', () => {
  let prisma: PrismaService;
  let override: OverrideService;

  let zoneId: bigint;
  let companyId: bigint;
  const plantIds: bigint[] = [];
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  let seLane: string;
  let seDirect: string;
  let seSeq: string;
  let seDead: string;

  const ZM = { userId: '11111111-1111-1111-1111-111111111111', role: 'ZONAL_MANAGER', actedAsRole: null };
  const NOW = new Date('2026-06-21T06:00:00Z');
  const DAY = istDate(NOW);
  let scope: { role: string; zoneId: number };

  const makeSe = async (label: string): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: `SE ${label} ${tag}`, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@o327.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({
      data: { engineerId: u.userId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 20 },
    });
    return u.userId;
  };

  const makeTicket = async (plantId: bigint): Promise<string> => {
    const deviceId = String(10_800_000_000 + (NS % 100_000) * 100 + deviceIds.length);
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

  const liveBatchRows = (ticketId: string) =>
    prisma.batchAssignmentTicket.findMany({ where: { ticketId, removedAt: null } });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    override = new OverrideService(prisma, new AuditService(prisma), new LoggingDayPlanNotifier());

    zoneId = (await prisma.zone.create({ data: { name: 'Z-327-' + NS } })).zoneId;
    scope = { role: 'ZONAL_MANAGER', zoneId: Number(zoneId) };
    companyId = (
      await prisma.company.create({ data: { name: 'Co-327-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    for (let i = 0; i < 3; i++) {
      plantIds.push((await prisma.plant.create({ data: { name: `P${i}-327-` + NS, zoneId } })).plantId);
    }
    seLane = await makeSe('lane');
    seDirect = await makeSe('direct');
    seSeq = await makeSe('seq');
    seDead = await makeSe('dead');
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
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: plantIds } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('AC1 — assign-batch and one-click assign on ONE ticket: no 5xx, one winner, one live row', async () => {
    const ticketId = await makeTicket(plantIds[0]);

    // The lane takes its `FOR UPDATE ... SKIP LOCKED` on the ticket and parks there, holding the row.
    const laneHasTicketLock = gate();
    const directWroteBatchRow = gate();
    let laneParked = false;
    const laneClient = hookedPrisma(prisma, async (path, args, run) => {
      const out = await run();
      if (!laneParked && isTicketLock(path, args)) {
        laneParked = true;
        laneHasTicketLock.open();
        // Pre-fix the one-click door reaches its batch-ticket insert while we hold the ticket row, and
        // opens this gate; post-fix it is stuck on the ticket row and the timeout releases us instead.
        await waitAtMost(directWroteBatchRow, 2_000);
      }
      return out;
    });
    const laneSvc = new OverrideService(laneClient, new AuditService(laneClient), new LoggingDayPlanNotifier());

    const directClient = hookedPrisma(prisma, async (path, _args, run) => {
      const out = await run();
      if (path === 'batchAssignmentTicket.create') directWroteBatchRow.open();
      return out;
    });
    const directSvc = new OverrideService(directClient, new AuditService(directClient), new LoggingDayPlanNotifier());

    const lane = laneSvc.assignBatch([{ seId: seLane, ticketIds: [ticketId] }], 'RACE', scope, ZM, NOW);
    await laneHasTicketLock.wait;
    const direct = directSvc.assignTicket(ticketId, seDirect, scope, ZM, NOW);
    const [laneOut, directOut] = await Promise.allSettled([lane, direct]);

    // AC1 — neither door surfaces the 40P01. Before the fix one of them rejected with
    // `DriverAdapterError: deadlock detected`, which both controllers turn into a 500.
    expect(laneOut.status).toBe('fulfilled');
    expect(directOut.status).toBe('fulfilled');
    if (laneOut.status !== 'fulfilled' || directOut.status !== 'fulfilled') return;

    // …and neither answers with the *other* symptom the finding names. `assignBatch` catches anything
    // a lane throws and reports `LANE_FAILED`, so pre-fix the deadlock did not reach the caller as a
    // rejection at all — it arrived as a lane that failed for no stated reason, which is the same
    // 40P01 wearing a friendlier name. A lane may lose a ticket; it may not fail as a whole.
    const laneResult = laneOut.value.lanes[0];
    const directResult = directOut.value;
    expect(laneResult.result).toBe('OK');

    // Exactly one winner, and the loser answers with the conflict shape the file already had.
    const laneWon = laneResult.assigned === 1;
    const directWon = directResult.result === 'OK';
    expect([laneWon, directWon].filter(Boolean)).toHaveLength(1);
    if (laneWon) {
      expect(directResult.result).toBe('ALREADY_ASSIGNED');
    } else {
      expect(laneResult.skipped.map((s) => s.reason)).toContain('LOST_RACE');
    }

    // …and the database agrees with whoever won: one live row, one assigned ticket.
    const rows = await liveBatchRows(ticketId);
    expect(rows).toHaveLength(1);
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    expect(ticket.assignmentState).toBe('FORMALLY_ASSIGNED');
  }, 30_000);

  it('AC1 — the one-click door takes the ticket row BEFORE it writes any assignment row', async () => {
    const ticketId = await makeTicket(plantIds[0]);
    const seen: string[] = [];
    const client = hookedPrisma(prisma, async (path, args, run) => {
      seen.push(isTicketLock(path, args) ? 'tickets:lock' : path);
      return run();
    });
    const svc = new OverrideService(client, new AuditService(client), new LoggingDayPlanNotifier());

    const out = await svc.assignTicket(ticketId, seDirect, scope, ZM, NOW);
    expect(out.result).toBe('OK');

    // The ordering itself, pinned without any timing: the contended ticket row is acquired first, and
    // every row this transaction writes is taken after it. This is the order `assignLane` and the
    // dispatch run already use (`batch-assignment.service.ts` — "#306: the ticket write comes FIRST").
    const lock = seen.indexOf('tickets:lock');
    expect(lock).toBe(0);
    expect(lock).toBeLessThan(seen.indexOf('batchAssignmentTicket.create'));
    expect(lock).toBeLessThan(seen.indexOf('ticket.update'));
  }, 30_000);

  it('AC2 — two adds landing on one schedule together mint DIFFERENT stop numbers', async () => {
    const first = await makeTicket(plantIds[1]);
    const second = await makeTicket(plantIds[2]);
    // Pre-created so both adds attach to the same schedule — the race under test is over the stop
    // number within one plan, not over the plan itself (that one is #265's, and already guarded).
    const schedule = await prisma.workSchedule.create({
      data: { seId: seSeq, zoneId, dateFrom: DAY, dateTo: DAY, status: 'ACTIVE', source: 'ZM_MANUAL' },
    });

    const firstComputed = gate();
    const secondComputed = gate();
    let firstParked = false;
    const firstClient = hookedPrisma(prisma, async (path, _args, run) => {
      const out = await run();
      if (!firstParked && path === 'plantBatchAssignment.aggregate') {
        firstParked = true;
        firstComputed.open();
        await waitAtMost(secondComputed, 2_000);
      }
      return out;
    });
    const secondClient = hookedPrisma(prisma, async (path, _args, run) => {
      const out = await run();
      if (path === 'plantBatchAssignment.aggregate') secondComputed.open();
      return out;
    });
    const svcA = new OverrideService(firstClient, new AuditService(firstClient), new LoggingDayPlanNotifier());
    const svcB = new OverrideService(secondClient, new AuditService(secondClient), new LoggingDayPlanNotifier());

    const a = svcA.assignTicket(first, seSeq, scope, ZM, NOW);
    await firstComputed.wait;
    const b = svcB.assignTicket(second, seSeq, scope, ZM, NOW);
    const [aOut, bOut] = await Promise.all([a, b]);
    expect(aOut.result).toBe('OK');
    expect(bOut.result).toBe('OK');

    const batches = await prisma.plantBatchAssignment.findMany({
      where: { scheduleId: schedule.scheduleId },
      orderBy: { stopSequence: 'asc' },
    });
    expect(batches).toHaveLength(2);
    // Before the fix both reads saw `max = null` and both wrote stop 1: two stops with one number, so
    // the SE's route order depended on which row the reader happened to return first.
    expect(batches.map((b) => b.stopSequence)).toEqual([1, 2]);
  }, 30_000);

  it('AC1 — a residual deadlock answers with the conflict shape, not a 500', async () => {
    const ticketId = await makeTicket(plantIds[0]);
    const schedule = await prisma.workSchedule.create({
      data: { seId: seDead, zoneId, dateFrom: DAY, dateTo: DAY, status: 'ACTIVE', source: 'ZM_MANUAL' },
    });
    const held = await prisma.plantBatchAssignment.create({
      data: { scheduleId: schedule.scheduleId, plantId: plantIds[1], seId: seDead, status: 'AUTO_ASSIGNED', stopSequence: 1 },
    });

    // A writer that takes the two rows in the OPPOSITE order — a stand-in for any path this slice does
    // not own. It holds a batch row, then asks for the ticket row the assign already holds.
    const competitorHoldsBatch = gate();
    const assignHoldsTicket = gate();
    const competitor = prisma
      .$transaction(async (tx) => {
        await tx.$executeRaw`UPDATE plant_batch_assignments SET stop_sequence = stop_sequence WHERE batch_id = ${held.batchId}`;
        competitorHoldsBatch.open();
        // Bounded: before the fix the assign never takes a ticket lock at all, so an unbounded wait
        // here would hang the spec on the very defect it is meant to report.
        await waitAtMost(assignHoldsTicket, 3_000);
        await tx.$queryRaw`SELECT ticket_id FROM tickets WHERE ticket_id = ${ticketId}::uuid FOR UPDATE`;
      }, { timeout: 30_000 })
      .then(() => null)
      .catch((e: unknown) => e);

    await competitorHoldsBatch.wait;
    const client = hookedPrisma(prisma, async (path, args, run) => {
      const out = await run();
      if (isTicketLock(path, args)) {
        assignHoldsTicket.open();
        // Postgres runs its deadlock check once per wait, `deadlock_timeout` (1s) after that wait
        // begins. Letting the competitor start waiting first — and pass its own check while no cycle
        // exists yet — makes THIS transaction the one that detects the cycle, and therefore the victim.
        // That is what makes the case test the mapping rather than the competitor's luck.
        await sleep(1_500);
      }
      return out;
    });
    const svc = new OverrideService(client, new AuditService(client), new LoggingDayPlanNotifier());

    // `insertAtTop` is what makes this assign renumber the held batch row, so the two writers contend.
    const out = await svc.assignTicket(ticketId, seDead, scope, ZM, NOW, 'CRITICAL_ASSIGN', true);
    await competitor;

    // The 40P01 the file cannot design away becomes the 409 both controllers already map, not a 500.
    expect(out.result).toBe('ALREADY_ASSIGNED');
    // Rolled back whole: no half-written assignment behind the refusal.
    expect(await liveBatchRows(ticketId)).toHaveLength(0);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { ticketId } })).assignmentState).toBe('UNASSIGNED');
  }, 30_000);

  it('the deadlock predicate reads the shape this driver adapter actually raises', () => {
    // Measured, not assumed — a 40P01 arrives as a `DriverAdapterError` with no Prisma `code` at all
    // and the Postgres code only on `cause`.
    const measured = Object.assign(new Error('deadlock detected'), {
      name: 'DriverAdapterError',
      cause: {
        originalCode: '40P01',
        originalMessage: 'deadlock detected',
        kind: 'postgres',
        code: '40P01',
        severity: 'ERROR',
      },
    });
    expect(isDeadlock(measured)).toBe(true);
    expect(isDeadlock(new Error('duplicate key value violates unique constraint'))).toBe(false);
    expect(isDeadlock({ code: 'P2002', meta: { modelName: 'BatchAssignmentTicket' } })).toBe(false);
    expect(isDeadlock(null)).toBe(false);
  });
});
