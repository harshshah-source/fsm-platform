import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { DispatchChangesTodayService } from '../src/scheduling/dispatch-changes-today.service';
import { LoggingDayPlanNotifier } from '../src/scheduling/day-plan-notifier';
import { OverrideService } from '../src/scheduling/override.service';

/**
 * #284 — the changes-today ledger, and the defect it replaces.
 *
 * The Intra-day Queue reads `audit_logs WHERE action = 'MANUAL_ZM_UPDATE'`, written only by
 * `POST /intraday-updates/*` — which no admin code calls. Every override an operator actually
 * performs goes through `POST /batches/:id/override` and audits as `BATCH_OVERRIDE_*`, so the one
 * surface claiming to answer "what changed today" cannot see the product's own changes. AC6 pins
 * exactly that case as a regression.
 */
const NS = Date.now();
const TODAY = new Date('2026-06-28T06:00:00Z');
const YESTERDAY = new Date('2026-06-27T06:00:00Z');

describe('#284 — GET /dispatch/changes-today', () => {
  let prisma: PrismaService;
  let svc: DispatchChangesTodayService;
  let override: OverrideService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let zmUserId: string;
  let seA: string;
  let seB: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];

  const scope = () => ({ role: 'ZONAL_MANAGER', zoneId: Number(zoneId) });
  const actor = () => ({ userId: zmUserId, role: 'ZONAL_MANAGER', actedAsRole: null });

  const makeSe = async (): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@p284c.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({
      data: { engineerId: u.userId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 8 },
    });
    await prisma.seCoverage.create({ data: { seId: u.userId, plantId, coverageType: 'DEDICATED' } });
    return u.userId;
  };

  const makeTicket = async (): Promise<string> => {
    const deviceId = String(11_950_000_000 + ((NS + deviceIds.length) % 100_000) + deviceIds.length);
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
    svc = new DispatchChangesTodayService(prisma);

    const zm = await prisma.user.create({
      data: { name: 'ZM ' + NS, role: 'ZONAL_MANAGER', phone: 'zm284c-' + NS, email: `zm-${NS}@p284c.test` },
    });
    zmUserId = zm.userId;
    userIds.push(zm.userId);
    zoneId = (await prisma.zone.create({ data: { name: 'Z-284c-' + NS, zonalManagerUserId: zm.userId } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-284c-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-284c-' + NS, zoneId } })).plantId;
    seA = await makeSe();
    seB = await makeSe();
  });

  afterEach(async () => {
    const schedules = await prisma.workSchedule.findMany({ where: { zoneId }, select: { scheduleId: true } });
    const batches = await prisma.plantBatchAssignment.findMany({
      where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } },
      select: { batchId: true },
    });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } } });
    await prisma.workSchedule.deleteMany({ where: { zoneId } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    ticketIds.length = 0;
    deviceIds.length = 0;
  });

  afterAll(async () => {
    await prisma.seCoverage.deleteMany({ where: { plantId } });
    await prisma.engineerMaster.deleteMany({ where: { zoneId } });
    await prisma.plant.deleteMany({ where: { zoneId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.onModuleDestroy();
  });

  it('AC6 — reports an override made through the door the Intra-day Queue cannot see', async () => {
    const ticketId = await makeTicket();
    await override.assignTicket(ticketId, seA, scope(), actor(), TODAY);

    const batch = await prisma.batchAssignmentTicket.findFirstOrThrow({
      where: { ticketId, removedAt: null },
      include: { batch: true },
    });
    // The real product path — `POST /batches/:id/override`, which audits as BATCH_OVERRIDE_REMOVE_TICKET
    // and therefore never appears in `listIntradayUpdates`.
    const res = await override.override(
      batch.batch.batchId,
      { action: 'REMOVE_TICKET', ticketId, reasonCode: 'Device already recovered on site' },
      scope(),
      actor(),
      TODAY,
    );
    expect(res.result).toBe('OK');

    const view = await svc.changesToday(scope(), { zoneId, now: TODAY });
    const removal = view.changes.find((c) => c.kind === 'REMOVE' && c.ticketId === ticketId);
    expect(removal).toBeDefined();
    expect(removal?.actorId).toBe(zmUserId);
    expect(removal?.via).toBe('ZM_WITHDRAWN');
  });

  /**
   * **The reason the operator was forced to type, read back.**
   *
   * `reason` on a REMOVE row was hard-coded `null` while ADD and SWAP carried theirs, so an override
   * the product *refuses to accept without a reason* published no reason at all. An operator deferred
   * three devices with three different explanations, and the Changes tab showed their name three times
   * followed by nothing.
   *
   * It could not simply be read off the row: `removal_reason` is a **closed vocabulary read as a
   * predicate** (#241 — #244 counts attempts off it, so free text there would silently change an
   * operational classification), and `plant_batch_assignments.override_reason` is *batch*-level and
   * last-writer-wins — after those three defers it held one string, and not the operator's first two.
   * So the words now live in `removal_note`, symmetric with the `add_reason` the add side already had.
   */
  it('a removal publishes the words the operator was made to type, not just the vocabulary code', async () => {
    const ticketId = await makeTicket();
    await override.assignTicket(ticketId, seA, scope(), actor(), TODAY);
    const row = await prisma.batchAssignmentTicket.findFirstOrThrow({
      where: { ticketId, removedAt: null },
      include: { batch: true },
    });

    await override.override(
      row.batch.batchId,
      { action: 'DEFER_TICKET', ticketId, deferredToDate: '2026-06-30', reasonCode: 'Vehicle return not confirmed yet' },
      scope(),
      actor(),
      TODAY,
    );

    const view = await svc.changesToday(scope(), { zoneId, now: TODAY });
    const removal = view.changes.find((c) => c.kind === 'REMOVE' && c.ticketId === ticketId);
    // `via` still carries the predicate; `reason` now carries the human's sentence. Both, not either.
    expect(removal?.via).toBe('ZM_DEFERRED');
    expect(removal?.reason).toBe('Vehicle return not confirmed yet');
  });

  /** A removal nobody typed a reason for stays null — absence is never filled in with a guess. */
  it('a system removal carries no invented reason', async () => {
    const ticketId = await makeTicket();
    await override.assignTicket(ticketId, seA, scope(), actor(), TODAY);
    const row = await prisma.batchAssignmentTicket.findFirstOrThrow({ where: { ticketId, removedAt: null } });
    await prisma.batchAssignmentTicket.update({
      where: { id: row.id },
      data: { removedAt: TODAY, removedBy: null, removalReason: 'PLAN_EXPIRED' },
    });

    const view = await svc.changesToday(scope(), { zoneId, now: TODAY });
    const removal = view.changes.find((c) => c.kind === 'REMOVE' && c.ticketId === ticketId);
    expect(removal?.reason ?? null).toBeNull();
  });

  it('AC8 — a swap counts once, not as one add plus one remove', async () => {
    const ticketId = await makeTicket();
    // Assigned yesterday so today's window contains the move and nothing else — otherwise the setup
    // assign is itself a change today, and it genuinely is one (see the test below).
    await override.assignTicket(ticketId, seA, scope(), actor(), YESTERDAY);
    const row = await prisma.batchAssignmentTicket.findFirstOrThrow({
      where: { ticketId, removedAt: null },
      include: { batch: true },
    });

    const res = await override.override(
      row.batch.batchId,
      { action: 'REASSIGN', ticketId, newSeId: seB, reasonCode: 'B is already at that plant today' },
      scope(),
      actor(),
      TODAY,
    );
    expect(res.result).toBe('OK');

    const view = await svc.changesToday(scope(), { zoneId, now: TODAY });
    const forTicket = view.changes.filter((c) => c.ticketId === ticketId);

    // One decision, one row — carrying both ends of the move.
    expect(forTicket.map((c) => c.kind)).toEqual(['SWAP']);
    expect(forTicket[0].fromSeId).toBe(seA);
    expect(forTicket[0].toSeId).toBe(seB);
    expect(view.counts.swaps).toBe(1);
  });

  it('assign-then-move on one day is two decisions, not one', async () => {
    // The counterpart to AC8: pairing keys on the move's destination row, not on the ticket, so an
    // earlier plain assign is not silently absorbed into a later swap of the same ticket.
    const ticketId = await makeTicket();
    await override.assignTicket(ticketId, seA, scope(), actor(), TODAY);
    const row = await prisma.batchAssignmentTicket.findFirstOrThrow({
      where: { ticketId, removedAt: null },
      include: { batch: true },
    });
    await override.override(
      row.batch.batchId,
      { action: 'REASSIGN', ticketId, newSeId: seB, reasonCode: 'Rebalanced after the morning walk-in' },
      scope(),
      actor(),
      TODAY,
    );

    const view = await svc.changesToday(scope(), { zoneId, now: TODAY });
    expect(view.changes.filter((c) => c.ticketId === ticketId).map((c) => c.kind)).toEqual(['ADD', 'SWAP']);
  });

  it('AC7 — yesterday’s identical change is not today’s', async () => {
    const ticketId = await makeTicket();
    await override.assignTicket(ticketId, seA, scope(), actor(), YESTERDAY);

    const yesterdayView = await svc.changesToday(scope(), { zoneId, now: YESTERDAY });
    expect(yesterdayView.changes.some((c) => c.ticketId === ticketId)).toBe(true);

    const todayView = await svc.changesToday(scope(), { zoneId, now: TODAY });
    expect(todayView.changes.some((c) => c.ticketId === ticketId)).toBe(false);
  });

  it('the morning run placing work is not 200 "changes today"', async () => {
    // The engine writes AUTO_DISPATCH with a null actor by construction (#283), which is exactly what
    // separates "the plan was produced" from "a person changed the plan".
    const ticketId = await makeTicket();
    const sched = await prisma.workSchedule.create({
      data: {
        seId: seA,
        zoneId,
        dateFrom: new Date('2026-06-28'),
        dateTo: new Date('2026-06-28'),
        status: 'ACTIVE',
        source: 'SYSTEM_GENERATED',
        dispatchedAt: TODAY,
      },
    });
    const batch = await prisma.plantBatchAssignment.create({
      data: { scheduleId: sched.scheduleId, plantId, seId: seA, status: 'AUTO_ASSIGNED', stopSequence: 1 },
    });
    await prisma.batchAssignmentTicket.create({
      data: { batchId: batch.batchId, ticketId, sortOrder: 1, addSource: 'AUTO_DISPATCH', addedBy: null },
    });

    const view = await svc.changesToday(scope(), { zoneId, now: TODAY });
    expect(view.changes.some((c) => c.ticketId === ticketId)).toBe(false);
  });
});
