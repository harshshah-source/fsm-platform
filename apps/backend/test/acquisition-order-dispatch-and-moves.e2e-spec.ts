import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import { istDate } from '../src/common/ist-day';
import { PrismaService } from '../src/prisma/prisma.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { LoggingDayPlanNotifier } from '../src/scheduling/day-plan-notifier';
import { OverrideService } from '../src/scheduling/override.service';
import { gate, hookedPrisma, isScheduleLock, isTicketLock, waitAtMost, watchDeadlocks } from './support/tx-hooks';

/**
 * #334 (forensics §8, follow-up to #327) — the two writers #327 named and left outside its boundary
 * are brought onto the same acquisition order:
 *
 * ```
 *   tickets  →  work_schedules  →  plant_batch_assignments  →  batch_assignment_tickets
 * ```
 *
 * **AC1 — the dispatch run.** `dispatchForSe` created or attached to the SE's schedule and only then
 * ran its guarded ticket write. A manual assign holding the ticket row and waiting on that schedule's
 * partial unique, against a run holding the schedule and waiting on the ticket, is a cycle. Narrow —
 * it needs the SE's *first* schedule of the day to be reached by both writers at once — and the 05:00
 * run against an eager manager is exactly that window.
 *
 * **AC2 — the two-schedule movers.** `moveTickets` and `swapSe` took the *destination* schedule first
 * (`ensureSchedule`) and stamped the *source* last (`flagOverridden`, and `swapSe`'s inline
 * `workSchedule.updateMany`). Two moves in opposite directions between one pair of engineers each held
 * the row the other needed next.
 *
 * Neither was a 500 — #327 maps a residual 40P01 to each door's own conflict outcome — but a mapped
 * deadlock is still an operation the operator has to repeat, and that is what these cases forbid.
 *
 * Staging is the hooked-client rendezvous shared from `test/support/tx-hooks.ts`; the bounded waits
 * are the assertion path, not padding.
 */
const NS = Date.now();

describe('#334 — the dispatch run and the cross-schedule moves join the acquisition order', () => {
  let prisma: PrismaService;

  let zoneId: bigint;
  let companyId: bigint;
  const plantIds: bigint[] = [];
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  let runId: bigint;

  const ZM = { userId: '11111111-1111-1111-1111-111111111111', role: 'ZONAL_MANAGER', actedAsRole: null };
  const NOW = new Date('2026-06-22T06:00:00Z');
  const DAY = istDate(NOW);
  let scope: { role: string; zoneId: number };

  const svc = (client: PrismaService): OverrideService =>
    new OverrideService(client, new AuditService(client), new LoggingDayPlanNotifier());
  const dispatcher = (client: PrismaService): BatchAssignmentService =>
    new BatchAssignmentService(client, new LoggingDayPlanNotifier());

  const makeSe = async (label: string): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: `SE ${label} ${tag}`, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@o334.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({
      data: { engineerId: u.userId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 20 },
    });
    return u.userId;
  };

  const makeTicket = async (plantId: bigint): Promise<string> => {
    const deviceId = String(10_900_000_000 + (NS % 100_000) * 100 + deviceIds.length);
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

  const suggest = (ticketId: string, seId: string, rank = 1) =>
    prisma.recommendation.create({
      data: { ticketId, seId, status: 'SUGGESTED', path: 'MORNING_BATCH', scoreBreakdown: {}, processingRank: rank, runId },
    });

  /** One plant batch on its own fresh schedule, holding one ticket — the shape both movers act on. */
  const seedPlan = async (seId: string, plantId: bigint, ticketId: string, stop = 1) => {
    const schedule = await prisma.workSchedule.create({
      data: { seId, zoneId, dateFrom: DAY, dateTo: DAY, status: 'ACTIVE', source: 'ZM_MANUAL' },
    });
    const batch = await prisma.plantBatchAssignment.create({
      data: { scheduleId: schedule.scheduleId, plantId, seId, status: 'AUTO_ASSIGNED', stopSequence: stop },
    });
    await prisma.batchAssignmentTicket.create({ data: { batchId: batch.batchId, ticketId, sortOrder: 1, createdAt: NOW } });
    await prisma.ticket.update({ where: { ticketId }, data: { assignmentState: 'FORMALLY_ASSIGNED' } });
    return { scheduleId: schedule.scheduleId, batchId: batch.batchId };
  };

  const liveBatchRows = (ticketId: string) =>
    prisma.batchAssignmentTicket.findMany({ where: { ticketId, removedAt: null } });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();

    zoneId = (await prisma.zone.create({ data: { name: 'Z-334-' + NS } })).zoneId;
    scope = { role: 'ZONAL_MANAGER', zoneId: Number(zoneId) };
    companyId = (
      await prisma.company.create({ data: { name: 'Co-334-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    for (let i = 0; i < 3; i++) {
      plantIds.push((await prisma.plant.create({ data: { name: `P${i}-334-` + NS, zoneId } })).plantId);
    }
    runId = (await prisma.dispatchRun.create({ data: { trigger: 'MANUAL', status: 'RUNNING', startedAt: NOW, configSnapshot: {} } })).runId;
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
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: plantIds } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.dispatchRun.deleteMany({ where: { runId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('AC1 — the dispatch run takes the ticket rows BEFORE it resolves the SE schedule', async () => {
    const se = await makeSe('order');
    const ticketId = await makeTicket(plantIds[0]);
    await suggest(ticketId, se);

    const seen: string[] = [];
    const client = hookedPrisma(prisma, async (path, args, run) => {
      seen.push(isScheduleLock(path, args) ? 'work_schedules:lock' : path);
      return run();
    });

    const out = await dispatcher(client).dispatchForZone(zoneId, { dateFrom: DAY, dateTo: DAY, now: NOW, runId });
    expect(out.tickets).toBe(1);

    // The ordering itself, pinned without any timing. This is the decision #334 records: the RUN moved,
    // not the manual doors — #327's documented order stays as written, and the change is one file.
    const firstTicketWrite = seen.indexOf('ticket.updateMany');
    const scheduleWrite = Math.min(
      ...['workSchedule.findFirst', 'workSchedule.create'].map((p) => seen.indexOf(p)).filter((i) => i >= 0),
    );
    expect(firstTicketWrite).toBeGreaterThanOrEqual(0);
    expect(scheduleWrite).toBeGreaterThan(firstTicketWrite);
    // …and every batch row still comes after the schedule, so the run extends the one order rather
    // than opening a second one.
    expect(seen.indexOf('plantBatchAssignment.create')).toBeGreaterThan(scheduleWrite);
  }, 30_000);

  it('AC1 — a manual assign concurrent with the dispatch run cannot deadlock', async () => {
    const se = await makeSe('race');
    const ticketId = await makeTicket(plantIds[1]);
    await suggest(ticketId, se);
    // The SE has NO schedule for the day: the run and the manual assign will both want to create the
    // first one, which is the only window in which the cycle exists.
    expect(await prisma.workSchedule.count({ where: { seId: se, dateFrom: DAY } })).toBe(0);

    const runResolvedSchedule = gate();
    const assignHoldsTicket = gate();
    // #327 maps a residual 40P01 onto each door's ordinary conflict outcome, so the two writers answer
    // a cycle and a fair race identically. The cycle has to be watched for at the statement.
    const deadlocks: string[] = [];
    let runParked = false;
    const runClient = hookedPrisma(prisma, watchDeadlocks(deadlocks, async (path, args, run) => {
      const out = await run();
      // The CREATE, not the lookup that precedes it: the lookup holds nothing, so parking there stages
      // a plain P2002 (the manual assign commits its schedule first and the run collides with it) —
      // real, already answered by #307, and not the cycle this case is about.
      if (!runParked && path === 'workSchedule.create') {
        runParked = true;
        runResolvedSchedule.open();
        // Pre-fix we are holding the freshly created schedule here and have not touched the ticket, so
        // the manual assign reaches its own ticket lock and opens the gate — then we walk into its
        // ticket row and Postgres breaks the cycle. Post-fix the ticket rows are already ours, so the
        // assign blocks before it can open anything and the timeout releases us to commit.
        await waitAtMost(assignHoldsTicket, 2_500);
      }
      return out;
    }));

    const assignClient = hookedPrisma(prisma, watchDeadlocks(deadlocks, async (path, args, run) => {
      const out = await run();
      if (isTicketLock(path, args)) assignHoldsTicket.open();
      return out;
    }));

    const dispatchRun = dispatcher(runClient)
      .dispatchForZone(zoneId, { dateFrom: DAY, dateTo: DAY, now: NOW, runId })
      .then((r) => ({ ok: true as const, r }))
      .catch((e: unknown) => ({ ok: false as const, e }));
    await runResolvedSchedule.wait;
    const manual = svc(assignClient)
      .assignTicket(ticketId, se, scope, ZM, NOW)
      .then((r) => ({ ok: true as const, r }))
      .catch((e: unknown) => ({ ok: false as const, e }));

    const [dispatched, assigned] = await Promise.all([dispatchRun, manual]);

    // AC1 — the cycle never forms. Pre-fix it does, on the run's `tickets.updateMany` against the
    // assign's `work_schedules` insert, and #327's mapping hides it: the loser is told the ticket was
    // already assigned, which is exactly what it would be told after a fair race.
    expect(deadlocks).toEqual([]);
    expect(assigned.ok).toBe(true);
    expect(dispatched.ok).toBe(true);
    if (!dispatched.ok || !assigned.ok) return;
    expect(dispatched.r.seSkips ?? []).toEqual([]);

    // Exactly one of the two placed the ticket, and the database agrees with whoever it was: one live
    // batch row, one schedule for the day, one assigned ticket.
    const placedByRun = dispatched.r.tickets === 1;
    const placedByHand = assigned.r.result === 'OK';
    expect([placedByRun, placedByHand].filter(Boolean)).toHaveLength(1);
    expect(await liveBatchRows(ticketId)).toHaveLength(1);
    expect(await prisma.workSchedule.count({ where: { seId: se, dateFrom: DAY } })).toBe(1);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { ticketId } })).assignmentState).toBe('FORMALLY_ASSIGNED');
  }, 30_000);

  it('AC2 — two cross-schedule moves in opposite directions cannot deadlock', async () => {
    const seA = await makeSe('moveA');
    const seB = await makeSe('moveB');
    const tA = await makeTicket(plantIds[0]);
    const tB = await makeTicket(plantIds[1]);
    const planA = await seedPlan(seA, plantIds[0], tA, 1);
    const planB = await seedPlan(seB, plantIds[1], tB, 1);

    const firstTookASchedule = gate();
    const secondTookASchedule = gate();
    const deadlocks: string[] = [];
    let firstParked = false;
    const firstClient = hookedPrisma(prisma, watchDeadlocks(deadlocks, async (path, args, run) => {
      const out = await run();
      if (!firstParked && isScheduleLock(path, args)) {
        firstParked = true;
        firstTookASchedule.open();
        // Pre-fix we hold the DESTINATION schedule and the other mover holds ITS destination — two
        // different rows, so neither blocks and both gates open; each then reaches for the other's row
        // as its source. Post-fix both take the LOWER schedule id first, so the second mover blocks
        // here and the timeout releases us to finish.
        await waitAtMost(secondTookASchedule, 2_500);
      }
      return out;
    }));
    const secondClient = hookedPrisma(prisma, watchDeadlocks(deadlocks, async (path, args, run) => {
      const out = await run();
      if (isScheduleLock(path, args)) secondTookASchedule.open();
      return out;
    }));

    // A → B and B → A at the same moment: the source of one is the destination of the other.
    const swapAtoB = svc(firstClient)
      .override(planA.batchId, { action: 'SWAP_SE', newSeId: seB, reasonCode: 'ZM_JUDGEMENT' }, scope, ZM, NOW)
      .then((r) => ({ ok: true as const, r }))
      .catch((e: unknown) => ({ ok: false as const, e }));
    await firstTookASchedule.wait;
    const swapBtoA = svc(secondClient)
      .override(planB.batchId, { action: 'SWAP_SE', newSeId: seA, reasonCode: 'ZM_JUDGEMENT' }, scope, ZM, NOW)
      .then((r) => ({ ok: true as const, r }))
      .catch((e: unknown) => ({ ok: false as const, e }));

    const [first, second] = await Promise.all([swapAtoB, swapBtoA]);

    // AC2 — the cycle never forms, and both moves complete. Pre-fix one of them hits the 40P01 on its
    // source stamp and #327 maps it to `NOT_FOUND` — a refusal about a batch the manager is looking at,
    // which they can only answer by clicking again.
    expect(deadlocks).toEqual([]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.r.result).toBe('OK');
    expect(second.r.result).toBe('OK');

    // …and the swap really happened on both sides: each batch now belongs to the other engineer.
    const rows = await prisma.plantBatchAssignment.findMany({ where: { batchId: { in: [planA.batchId, planB.batchId] } } });
    expect(rows.find((b) => b.batchId === planA.batchId)?.seId).toBe(seB);
    expect(rows.find((b) => b.batchId === planB.batchId)?.seId).toBe(seA);
  }, 30_000);

  it('AC2 — a mover locks the lower schedule id first, whichever end of the move it is', async () => {
    const seA = await makeSe('ordA');
    const seB = await makeSe('ordB');
    const tA = await makeTicket(plantIds[2]);
    const planA = await seedPlan(seA, plantIds[2], tA, 1);
    // Created after A, so B's schedule id is the HIGHER one and the destination is not the row the
    // deterministic order takes first — the case a "lock the destination first" rule gets wrong.
    const tB = await makeTicket(plantIds[2]);
    const planB = await seedPlan(seB, plantIds[2], tB, 1);
    expect(planA.scheduleId < planB.scheduleId).toBe(true);

    const locks: bigint[] = [];
    const client = hookedPrisma(prisma, async (path, args, run) => {
      if (isScheduleLock(path, args)) locks.push(BigInt(String(args[1])));
      return run();
    });

    // A → B: the source is the LOW id, the destination the high one.
    const up = await svc(client).override(
      planA.batchId,
      { action: 'SWAP_SE', newSeId: seB, reasonCode: 'ZM_JUDGEMENT' },
      scope,
      ZM,
      NOW,
    );
    expect(up.result).toBe('OK');
    expect(locks.slice(0, 2)).toEqual([planA.scheduleId, planB.scheduleId]);

    // And the mirror: B → A, where the destination is the LOW id. The order must not depend on which
    // end of the move a schedule sits at — that is the whole content of "deterministic".
    locks.length = 0;
    const down = await svc(client).override(
      planB.batchId,
      { action: 'SWAP_SE', newSeId: seA, reasonCode: 'ZM_JUDGEMENT' },
      scope,
      ZM,
      NOW,
    );
    expect(down.result).toBe('OK');
    expect(locks.slice(0, 2)).toEqual([planA.scheduleId, planB.scheduleId]);
  }, 30_000);
});
