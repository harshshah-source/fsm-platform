import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import { istDate } from '../src/common/ist-day';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { DispatchRunService } from '../src/scheduling/dispatch-run.service';
import { SchedulerPreviewService } from '../src/scheduling/scheduler-preview.service';

/**
 * #306 (forensics RC-6 + RC-7) — hold/deferral integrity across the dispatch window.
 *
 * One invariant, two writers, and both were violable:
 *
 *  - **RC-6** — `placeHold` checked OPEN+UNASSIGNED with a plain read and wrote by primary key. A
 *    dispatch committing in between left a hold on already-assigned work: a live batch row the write
 *    does not touch, plus a `deferred_until` that silently holds the ticket out of *every* future run
 *    the moment it is REMOVEd back to the pool.
 *  - **RC-7** — dispatch cleared `deferredUntil` unconditionally, so a hold placed between the
 *    recommender's SUGGESTED write and the per-SE transaction was erased, leaving an audit trail
 *    showing a hold placed and nothing overriding it. A ticket CLOSED in the same window still landed
 *    on a day plan.
 *
 * The policy is the existing contract, not a new rule: holds win over the engine (#251 — a hold is "a
 * date the existing `notDeferredOn` predicate already respects"; #249 — every manual door needs
 * confirm+reason to break one). Dispatch therefore SKIPS, counted, and never overrides.
 *
 * The window is staged deterministically rather than by timing: the recommender writes SUGGESTED, the
 * test then does what an operator does on the preview screen, and only then does dispatch run. That is
 * the real sequence — the window is minutes wide in production, which is why the preview screen sits
 * in it.
 */
const NS = Date.now();

/**
 * A Prisma facade that runs `interfere()` exactly once, immediately before the next `$transaction` —
 * the window between a caller's pre-read and its guarded write. Everything else passes straight
 * through, so the service under test sees the real database and only the *timing* is controlled.
 * (Same technique as #301/#302's specs; no production seam is added for a test's benefit.)
 */
function interferingPrisma(prisma: PrismaService, interfere: () => Promise<unknown>): PrismaService {
  let fired = false;
  return new Proxy(prisma, {
    get(target, prop, receiver) {
      if (prop === '$transaction') {
        return async (...args: unknown[]) => {
          if (!fired) {
            fired = true;
            await interfere();
          }
          return (target as unknown as Record<string, (...a: unknown[]) => unknown>).$transaction(...args);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as PrismaService;
}

describe('#306 — a hold survives the dispatch window', () => {
  let prisma: PrismaService;
  let rec: RecommenderService;
  let dispatch: BatchAssignmentService;
  let preview: SchedulerPreviewService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let seId: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  const NOW = new Date('2026-06-21T06:00:00Z');
  const DAY = istDate(NOW);
  const TOMORROW = new Date(DAY.getTime() + 24 * 60 * 60_000);

  const zm = { userId: randomUUID(), role: 'OPERATIONS_HEAD', actedAsRole: null };
  const anyZone = { role: 'OPERATIONS_HEAD', zoneId: null };

  const makeTicket = async (gpsAgeMin: number): Promise<string> => {
    const deviceId = String(9_460_000_000 + (NS % 100_000) * 10 + deviceIds.length);
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

  const runDispatch = () => dispatch.dispatchForZone(zoneId, { dateFrom: DAY, dateTo: DAY, now: NOW });

  const liveBatchRows = (ticketId: string) =>
    prisma.batchAssignmentTicket.findMany({ where: { ticketId, removedAt: null } });

  /** Wipe everything a previous case dispatched, so each starts from an empty plan. */
  const resetPlans = async (): Promise<void> => {
    const schedules = await prisma.workSchedule.findMany({ where: { zoneId }, select: { scheduleId: true } });
    const batches = await prisma.plantBatchAssignment.findMany({
      where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } },
      select: { batchId: true },
    });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.dayPlanNotificationOutbox.deleteMany({ where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } } });
    await prisma.workSchedule.deleteMany({ where: { zoneId } });
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    rec = new RecommenderService(prisma, new CandidateSelectionService(prisma));
    dispatch = new BatchAssignmentService(prisma);
    preview = new SchedulerPreviewService(
      prisma,
      null as unknown as DispatchRunService, // `placeHold` never reaches the run service.
      new AuditService(prisma),
    );

    zoneId = (await prisma.zone.create({ data: { name: 'Z-306-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-306-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-306-' + NS, zoneId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@h306.test`, zoneId },
    });
    userIds.push(u.userId);
    seId = u.userId;
    await prisma.engineerMaster.create({
      data: { engineerId: seId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 },
    });
    await prisma.seCoverage.create({ data: { seId, plantId, coverageType: 'DEDICATED' } });
  });

  afterEach(async () => {
    await resetPlans();
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ticketIds } } });
    await prisma.ticket.updateMany({
      where: { ticketId: { in: ticketIds } },
      data: { status: 'OPEN', assignmentState: 'UNASSIGNED', deferredUntil: null, closureType: null, closedAt: null },
    });
  });

  afterAll(async () => {
    await resetPlans();
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ticketIds } } });
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

  it('AC2 — a hold placed after SUGGESTED is not dispatched, survives, and is a NAMED skip', async () => {
    const held = await makeTicket(120);
    const other = await makeTicket(60);
    await rec.runForZone(zoneId, { now: NOW });

    // The window: SUGGESTED is written, the ZM holds the ticket, then the run commits.
    expect(await preview.placeHold(held, TOMORROW, 'PARTS_AWAITED', anyZone, zm, { now: NOW })).toMatchObject({ result: 'OK' });
    const summary = await runDispatch();

    // Skipped, and said so — a run that quietly dispatched a held ticket and one with nothing held
    // must not report the same thing.
    expect(summary.ticketSkips).toEqual([{ ticketId: held, reason: 'DEFERRED' }]);
    expect(await liveBatchRows(held)).toHaveLength(0);
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: held } });
    expect(ticket.assignmentState).toBe('UNASSIGNED');
    // The hold itself survives, which is the half that used to be erased silently.
    expect(ticket.deferredUntil?.toISOString().slice(0, 10)).toBe(TOMORROW.toISOString().slice(0, 10));
    // The audit trail is honest: a hold placed, and nothing recording it being overridden.
    expect(
      await prisma.auditLog.count({ where: { entityId: held, action: 'SCHEDULER_HOLD_PLACED' } }),
    ).toBe(1);
    // The SE's other work is untouched — one held ticket is not a failed dispatch.
    expect(await liveBatchRows(other)).toHaveLength(1);
  });

  it('AC3 — a ticket resolved in the window never reaches a day plan', async () => {
    const closed = await makeTicket(120);
    const other = await makeTicket(60);
    await rec.runForZone(zoneId, { now: NOW });

    await prisma.ticket.update({
      where: { ticketId: closed },
      data: { status: 'CLOSED', closureType: 'ZM_MANUAL_CLOSE', closedAt: NOW },
    });
    const summary = await runDispatch();

    // Before #306 this landed on the plan and stayed there until the 04:00 closure recycled it.
    expect(summary.ticketSkips).toEqual([{ ticketId: closed, reason: 'NOT_OPEN' }]);
    expect(await liveBatchRows(closed)).toHaveLength(0);
    expect(await liveBatchRows(other)).toHaveLength(1);
  });

  /**
   * AC1, asserted as the invariant rather than as one ordering: whichever writer got there first, the
   * end state may not be a formally-assigned ticket carrying a live future hold.
   */
  it('AC1 — assign-then-hold cannot leave a FORMALLY_ASSIGNED ticket with a live future deferral', async () => {
    const ticketId = await makeTicket(120);
    await rec.runForZone(zoneId, { now: NOW });
    await runDispatch();

    // The other ordering: dispatch won, and the hold arrives afterwards.
    const outcome = await preview.placeHold(ticketId, TOMORROW, 'PARTS_AWAITED', anyZone, zm, { now: NOW });

    expect(outcome).toMatchObject({ result: 'NOT_HOLDABLE', assignmentState: 'FORMALLY_ASSIGNED' });
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    expect(ticket.assignmentState).toBe('FORMALLY_ASSIGNED');
    expect(ticket.deferredUntil).toBeNull();
    // And no audit row claiming a hold that never took — `withAudit` commits with the write or not at all.
    expect(await prisma.auditLog.count({ where: { entityId: ticketId, action: 'SCHEDULER_HOLD_PLACED' } })).toBe(0);
  });

  /**
   * **The guard's own race, not the pre-read's** — the case RC-6 is actually about.
   *
   * `placeHold`'s OPEN/UNASSIGNED check and its write are separated by a vehicle-report read and a
   * transaction start, and a dispatch committing in that gap slips past the check entirely. Testing
   * that requires interleaving at the write, not before the call: the ticket is flipped once,
   * immediately before `withAudit` opens its transaction, so the check provably saw OPEN/UNASSIGNED
   * and only the WHERE can catch it. Both services are built on the interfering client because
   * `withAudit` opens the transaction on the AuditService's own connection.
   */
  it('AC1 — placeHold refuses when the ticket is assigned between its own check and its write', async () => {
    const ticketId = await makeTicket(120);
    const raced = interferingPrisma(prisma, () =>
      prisma.ticket.update({ where: { ticketId }, data: { assignmentState: 'FORMALLY_ASSIGNED' } }),
    );
    const racedPreview = new SchedulerPreviewService(
      raced,
      null as unknown as DispatchRunService,
      new AuditService(raced),
    );

    const outcome = await racedPreview.placeHold(ticketId, TOMORROW, 'PARTS_AWAITED', anyZone, zm, { now: NOW });

    expect(outcome).toMatchObject({ result: 'NOT_HOLDABLE', assignmentState: 'FORMALLY_ASSIGNED' });
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    // No hold landed on assigned work — the stranding this issue is about.
    expect(ticket.deferredUntil).toBeNull();
    // And no audit row for a hold that never took: `withAudit` writes it in the same transaction, so
    // throwing rather than returning is what keeps the trail honest.
    expect(await prisma.auditLog.count({ where: { entityId: ticketId, action: 'SCHEDULER_HOLD_PLACED' } })).toBe(0);
  });

  /**
   * The regression the issue names as its main risk: the predicate is `notDeferredOn(day)`, NOT
   * `deferredUntil IS NULL`. A ticket held until today is due back today and must dispatch, with its
   * spent deferral cleared exactly as `:283` always did.
   */
  it('regression — a deferral due today still dispatches, and is cleared', async () => {
    const due = await makeTicket(120);
    await prisma.ticket.update({ where: { ticketId: due }, data: { deferredUntil: DAY } });
    await rec.runForZone(zoneId, { now: NOW });

    const summary = await runDispatch();

    expect(summary.ticketSkips).toBeUndefined();
    expect(await liveBatchRows(due)).toHaveLength(1);
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: due } });
    expect(ticket.assignmentState).toBe('FORMALLY_ASSIGNED');
    expect(ticket.deferredUntil).toBeNull();
  });
});
