import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import { SeAvailabilityService } from '../src/engineers/se-availability.service';
import { IntradayInsertionService } from '../src/intraday/intraday-insertion.service';
import { NotificationService } from '../src/notifications/notification.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { LoggingDayPlanNotifier } from '../src/scheduling/day-plan-notifier';
import { DispatchTodayQueryService } from '../src/scheduling/dispatch-today-query.service';
import { OverrideService } from '../src/scheduling/override.service';
import { expectExactlyOneWinner } from './support/concurrency';

/**
 * #298 (CB-2) — a manual assignment closes the escalation it resolves.
 *
 * **The defect.** The Scheduler Console's red interception strip says "N critical tickets need manual
 * assignment" and offers "Assign this work →". An operator who did exactly that saw the row come back
 * on the very next refetch, still counted in `criticalNeedsYou`, now reading "Reassign this work →".
 * The escalation never cleared, through any number of correct assignments.
 *
 * A cross-layer defect where every component looked right on its own: the strip's Assign door resolves
 * to `POST /schedules/assign` → `OverrideService.assignTicket`, which never touched
 * `intraday_insertions`; only `moveTickets` (#288) and the Intra-day Queue's own `manualAssign` closed
 * an `ESCALATION_REQUIRED` row; and the cockpit read filters on that status alone.
 *
 * **What is under test is the round trip**, not either half: escalate through the real writer, assign
 * through the real door, then ask the cockpit — which is the question no existing suite asked.
 * `criticalNeedsYou` is asserted alongside `escalations` because the strip's headline count and its
 * rows are two reads of one fact, and a fix that cleared only one would still show the operator a
 * contradiction.
 *
 * Services are constructed directly rather than through a Nest app, as the sibling escalation specs do
 * (`intraday-critical-insertion`, `se-unavailable-stranded-work`) — the seam is the service, and the
 * controller adds nothing this issue is about.
 */
const NS = Date.now();
/** 11:30 IST on the operating day the fixture builds — inside the field day, so "today" is unambiguous. */
const BASE = new Date('2026-06-28T06:00:00Z');
const DAY = new Date('2026-06-28T00:00:00Z');

describe('#298 — a manual assignment closes the escalation it resolves', () => {
  let prisma: PrismaService;
  let override: OverrideService;
  let intraday: IntradayInsertionService;
  let cockpit: DispatchTodayQueryService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let zmUserId: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];

  const zmScope = () => ({ role: 'ZONAL_MANAGER', zoneId: Number(zoneId) });
  const zmActor = () => ({ userId: zmUserId, role: 'ZONAL_MANAGER', actedAsRole: null });

  const makeSe = async (opts: { dailyCapacity?: number } = {}): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@ce.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({
      data: { engineerId: u.userId, coverageType: 'DEDICATED', zoneId, dailyCapacity: opts.dailyCapacity ?? 10 },
    });
    await prisma.seCoverage.create({ data: { seId: u.userId, plantId, coverageType: 'DEDICATED' } });
    return u.userId;
  };

  const makeCriticalTicket = async (): Promise<string> => {
    const deviceId = String(11_900_000_000 + ((NS + deviceIds.length) % 100_000) + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        hasOpenFailureCycle: true,
        latestGpsDatetime: new Date(BASE.getTime() - 30 * 60 * 60_000),
        plantId,
        companyId,
        computedAt: BASE,
      },
    });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: BASE } });
    const t = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        failureCycleId: cycle.cycleId,
        deviceId,
        plantId,
        companyId,
        companyTier: 'GOLD',
        lastStateChangedAt: BASE,
      },
    });
    ticketIds.push(t.ticketId);
    return t.ticketId;
  };

  /**
   * The real Q-B escalation (#258), produced by the real writer: an SE at capacity is the *only*
   * eligible candidate, so the intra-day sweep refuses to self-authorise the overload and escalates
   * instead. The escalated ticket is left UNASSIGNED — which is precisely the state in which the
   * strip offers "Assign this work →" rather than "Reassign", and therefore the state the broken
   * door was reached from.
   *
   * Constructing the insertion row by hand would have been the #297 mistake in a new place: the row
   * this writes carries `insertionType`, `offeredSeId: null` and `acceptanceDeadline: null` together,
   * and a fixture is free to get that combination wrong in a way production never can.
   */
  const escalateForNoCapacity = async (): Promise<{ ticketId: string; insertionId: bigint; se: string }> => {
    const se = await makeSe({ dailyCapacity: 1 });
    const schedule = await prisma.workSchedule.create({
      data: { seId: se, zoneId, dateFrom: DAY, dateTo: DAY, status: 'ACTIVE', dispatchedAt: BASE },
    });
    const filler = await makeCriticalTicket();
    const batch = await prisma.plantBatchAssignment.create({
      data: { scheduleId: schedule.scheduleId, plantId, seId: se, status: 'AUTO_ASSIGNED', stopSequence: 1 },
    });
    await prisma.batchAssignmentTicket.create({ data: { batchId: batch.batchId, ticketId: filler, sortOrder: 1 } });
    await prisma.ticket.update({ where: { ticketId: filler }, data: { assignmentState: 'FORMALLY_ASSIGNED' } });

    const ticketId = await makeCriticalTicket();
    const outcome = await intraday.assignCriticalForZone(zoneId, BASE);
    // No candidate could take it without breaching capacity, so the sweep escalated rather than
    // self-authorising the overload — the state the fixture needs, asserted so a fixture that silently
    // stopped producing an escalation fails here rather than several assertions later.
    expect(outcome).toEqual({ assigned: 0, escalated: 1 });

    const ins = await prisma.intradayInsertion.findFirstOrThrow({
      where: { ticketId },
      orderBy: { insertionId: 'desc' },
    });
    expect(ins.status).toBe('ESCALATION_REQUIRED');
    return { ticketId, insertionId: ins.insertionId, se };
  };

  const openEscalationsFor = (ticketId: string) =>
    prisma.intradayInsertion.findMany({ where: { ticketId, status: 'ESCALATION_REQUIRED' } });

  const cockpitToday = () => cockpit.today(zmScope(), { zoneId, now: BASE });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    override = new OverrideService(prisma, new AuditService(prisma), new LoggingDayPlanNotifier());
    cockpit = new DispatchTodayQueryService(prisma);
    intraday = new IntradayInsertionService(
      prisma,
      new CandidateSelectionService(prisma),
      override,
      new NotificationService(prisma),
      new SeAvailabilityService(prisma),
      new AuditService(prisma),
    );

    const zm = await prisma.user.create({
      data: { name: 'ZM ' + NS, role: 'ZONAL_MANAGER', phone: 'zm-ce-' + NS, email: `zm-ce-${NS}@ce.test` },
    });
    zmUserId = zm.userId;
    userIds.push(zm.userId);
    zoneId = (await prisma.zone.create({ data: { name: 'Z-ce-' + NS, zonalManagerUserId: zm.userId } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-ce-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-ce-' + NS, zoneId } })).plantId;
  });

  afterEach(async () => {
    await prisma.intradayInsertion.deleteMany({ where: { zoneId } });
    const schedules = await prisma.workSchedule.findMany({ where: { zoneId }, select: { scheduleId: true } });
    const batches = await prisma.plantBatchAssignment.findMany({
      where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } },
      select: { batchId: true },
    });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } } });
    await prisma.workSchedule.deleteMany({ where: { zoneId } });
    await prisma.notification.deleteMany({ where: { recipientUserId: { in: userIds } } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [...ticketIds, ...userIds] } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seCoverage.deleteMany({ where: { plantId } });
    await prisma.seAvailability.deleteMany({ where: { seId: { in: userIds } } });
    // Scoped to the zone rather than to `userIds`, deliberately. Every fixture SE here carries a
    // `daily_capacity`, and one engineer surviving a test is not a leak — it is a candidate with spare
    // capacity, which silently converts the next test's escalation into an assignment. Keyed on the
    // zone, the reset cannot depend on the bookkeeping array being intact.
    await prisma.engineerMaster.deleteMany({ where: { zoneId } });
    await prisma.user.deleteMany({ where: { zoneId, userId: { not: zmUserId } } });
    ticketIds.length = 0;
    deviceIds.length = 0;
    userIds.length = 1; // keep the ZM
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { userId: zmUserId } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  /**
   * AC1 through the strip's own door. The operator sees the row, clicks "Assign this work →", picks an
   * engineer — `ActionsBand` → `POST /schedules/assign` → `assignTicket` — and the strip must be empty
   * on the refetch that immediately follows.
   */
  it('AC1 — assignTicket closes the escalation, and the cockpit strip clears on the next read', async () => {
    const { ticketId } = await escalateForNoCapacity();
    const rescuer = await makeSe();

    const before = await cockpitToday();
    expect(before.escalations.map((e) => e.ticketId)).toContain(ticketId);
    expect(before.situation.criticalNeedsYou).toBe(before.escalations.length);
    const strippedOfThisOne = before.escalations.length - 1;

    const assigned = await override.assignTicket(ticketId, rescuer, zmScope(), zmActor(), BASE);
    expect(assigned.result).toBe('OK');

    const row = await prisma.intradayInsertion.findFirstOrThrow({
      where: { ticketId },
      orderBy: { insertionId: 'desc' },
    });
    expect(row.status).toBe('ACCEPTED');
    // Who resolved it, and when — the same two facts `moveTickets` and `manualAssign` record, so the
    // ledger reads identically whichever of the three doors a manager took.
    expect(row.offeredSeId).toBe(rescuer);
    expect(row.respondedAt).toEqual(BASE);

    const after = await cockpitToday();
    expect(after.escalations.map((e) => e.ticketId)).not.toContain(ticketId);
    // The headline count and the rows are two reads of one fact; both must move together.
    expect(after.situation.criticalNeedsYou).toBe(strippedOfThisOne);
    expect(after.situation.criticalNeedsYou).toBe(after.escalations.length);
  });

  /**
   * The Console's *other* assign door. Assign mode stages a draft and commits it through
   * `POST /schedules/assign-batch` → `assignLane`, which deliberately does not route through
   * `assignTicket` (its own per-SE transaction, #275/#262) — so the stamp had to be added there too.
   * A test that only covered `assignTicket` would have left the draft-commit path silently broken.
   */
  it('AC1 — the assign-batch lane closes it too, on the path that does not route through assignTicket', async () => {
    const { ticketId } = await escalateForNoCapacity();
    const rescuer = await makeSe();

    const result = await override.assignBatch(
      [{ seId: rescuer, ticketIds: [ticketId] }],
      'covering the capacity gap',
      zmScope(),
      zmActor(),
      BASE,
    );
    expect(result.lanes[0]).toMatchObject({ result: 'OK', assigned: 1 });

    expect(await openEscalationsFor(ticketId)).toHaveLength(0);
    const row = await prisma.intradayInsertion.findFirstOrThrow({
      where: { ticketId },
      orderBy: { insertionId: 'desc' },
    });
    expect(row.status).toBe('ACCEPTED');
    expect(row.offeredSeId).toBe(rescuer);

    const after = await cockpitToday();
    expect(after.escalations.map((e) => e.ticketId)).not.toContain(ticketId);
  });

  /**
   * The lane stamp is scoped to the tickets the lane actually wrote. A ticket somebody else assigned a
   * moment earlier comes back `alreadyAssigned` and resolves nothing *here*, so its escalation — if it
   * still had one — must not be closed by this lane's commit. Assigning the sibling proves the lane
   * still does its job for the ticket it did write, so the scoping is not just "nothing happened".
   */
  it('a lane closes escalations only for the tickets it actually assigned', async () => {
    const first = await escalateForNoCapacity();
    const second = await escalateForNoCapacity();
    const rescuer = await makeSe();

    // Somebody else got to `first` already — through the other door, which closes its escalation.
    expect((await override.assignTicket(first.ticketId, rescuer, zmScope(), zmActor(), BASE)).result).toBe('OK');
    // Re-open it, to isolate what this test is about: the lane's scoping, not the earlier assign.
    await prisma.intradayInsertion.updateMany({
      where: { ticketId: first.ticketId },
      data: { status: 'ESCALATION_REQUIRED', offeredSeId: null, respondedAt: null },
    });

    const result = await override.assignBatch(
      [{ seId: rescuer, ticketIds: [first.ticketId, second.ticketId] }],
      'one already gone, one still open',
      zmScope(),
      zmActor(),
      BASE,
    );
    expect(result.lanes[0]).toMatchObject({ result: 'OK', assigned: 1, alreadyAssigned: 1 });

    // The one this lane wrote is resolved; the one it merely skipped is untouched.
    expect(await openEscalationsFor(second.ticketId)).toHaveLength(0);
    expect(await openEscalationsFor(first.ticketId)).toHaveLength(1);
  });

  /**
   * AC2 — the stamp lives inside the assignment's transaction, so a rolled-back assign closes nothing.
   * Driven by making the assignment itself fail at the last write rather than by mocking the stamp: a
   * second manager takes the ticket in the window, so this call's `batch_assignment_tickets` insert
   * hits the one-active-per-ticket unique index. Per #265 a P2002 aborts the whole Postgres
   * transaction — which is exactly the rollback under test, and the reason this stamp had to go inside
   * the transaction rather than after the call returned.
   */
  it('AC2 — an assignment that loses the race and rolls back leaves the escalation open', async () => {
    const { ticketId } = await escalateForNoCapacity();
    const winner = await makeSe();
    const loser = await makeSe();

    // The winner's assign closes it, as AC1 requires. Asserted rather than assumed, so this test also
    // fails when the stamp is missing entirely — otherwise its negative assertion below would pass
    // trivially on the very defect the slice fixes.
    expect((await override.assignTicket(ticketId, winner, zmScope(), zmActor(), BASE)).result).toBe('OK');
    expect(await openEscalationsFor(ticketId)).toHaveLength(0);
    // Re-open the row to set the stage for a *losing* assign meeting a still-open escalation, which is
    // the case AC2 is about.
    await prisma.intradayInsertion.updateMany({
      where: { ticketId },
      data: { status: 'ESCALATION_REQUIRED', offeredSeId: null, respondedAt: null },
    });

    const second = await override.assignTicket(ticketId, loser, zmScope(), zmActor(), BASE);
    expect(second.result).toBe('ALREADY_ASSIGNED');

    // Nothing was written by the call that rolled back: the escalation is exactly as it was.
    const rows = await openEscalationsFor(ticketId);
    expect(rows).toHaveLength(1);
    expect(rows[0].offeredSeId).toBeNull();
    expect(rows[0].respondedAt).toBeNull();
  });

  /**
   * AC3 — removal is deliberately NOT a closer (#288's recorded rule). A ticket taken off the plan is
   * genuinely unassigned work that still needs somebody, and the read surfaces flip to offering Assign
   * for it on their own. This is the case that makes the strip's two verbs mean different things, so
   * it is pinned rather than assumed.
   */
  it('AC3 — removing the ticket from a plan does not close the escalation; the later assign does', async () => {
    const { ticketId } = await escalateForNoCapacity();
    const holder = await makeSe();
    const rescuer = await makeSe();

    // Put it on a plan and take it straight off again, through the real override door.
    const assigned = await override.assignTicket(ticketId, holder, zmScope(), zmActor(), BASE);
    expect(assigned.result).toBe('OK');
    await prisma.intradayInsertion.updateMany({
      where: { ticketId },
      data: { status: 'ESCALATION_REQUIRED', offeredSeId: null, respondedAt: null },
    });

    const removed = await override.override(
      BigInt(assigned.result === 'OK' ? assigned.batchId : '0'),
      { action: 'REMOVE_TICKET', ticketId, reasonCode: 'wrong engineer for this fault' },
      zmScope(),
      zmActor(),
      BASE,
    );
    expect(removed.result).toBe('OK');
    // Still open: nobody has decided who does this work.
    expect(await openEscalationsFor(ticketId)).toHaveLength(1);
    // And the strip now offers Assign rather than Reassign, because nobody holds it.
    const mid = await cockpitToday();
    expect(mid.escalations.find((e) => e.ticketId === ticketId)?.assignedSeId).toBeNull();

    // Taking that door is what closes it.
    expect((await override.assignTicket(ticketId, rescuer, zmScope(), zmActor(), BASE)).result).toBe('OK');
    expect(await openEscalationsFor(ticketId)).toHaveLength(0);
  });

  /**
   * The two doors racing on one escalation. **A start-together race, not a barriered one**: neither
   * `assignTicket` nor `manualAssign` exposes an injection point at the contended write, and the
   * harness's own guidance is to say so rather than claim an overlap the test does not create.
   *
   * The invariant asserted is not "the second one threw" — it is that exactly one call did the work
   * and the ledger records exactly one responder, whichever way round they land. That holds by
   * construction rather than by timing: the losing `assignTicket` returns `ALREADY_ASSIGNED` before it
   * opens a transaction, and `manualAssign` returns early on that outcome without ever reaching its
   * own update — so the row cannot be double-responded.
   */
  it('console assign vs intraday manual-assign on one row: exactly one responder is recorded', async () => {
    const { ticketId, insertionId } = await escalateForNoCapacity();
    const viaConsole = await makeSe();
    const viaQueue = await makeSe();

    const settle = async <T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> => {
      try {
        return { ok: true, value: await p };
      } catch (error) {
        return { ok: false, error };
      }
    };
    const results = await Promise.all([
      settle(override.assignTicket(ticketId, viaConsole, zmScope(), zmActor(), BASE)),
      settle(intraday.manualAssign(insertionId, viaQueue, zmActor(), zmScope(), BASE)),
    ]);

    expectExactlyOneWinner(results as never, (v: { result: string }) => v.result === 'OK');

    expect(await openEscalationsFor(ticketId)).toHaveLength(0);
    const rows = await prisma.intradayInsertion.findMany({ where: { ticketId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('ACCEPTED');
    // One responder, and it is the engineer the winning call named — never a blend of the two.
    expect([viaConsole, viaQueue]).toContain(rows[0].offeredSeId);
    const assignedTo = await prisma.batchAssignmentTicket.findFirstOrThrow({ where: { ticketId, removedAt: null }, include: { batch: true } });
    expect(assignedTo.batch.seId).toBe(rows[0].offeredSeId);
  });
});
