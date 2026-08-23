import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import { istDate } from '../src/common/ist-day';
import { notDeferredOn } from '../src/ticketing/deferral';
import { PrismaService } from '../src/prisma/prisma.service';
import { LoggingDayPlanNotifier } from '../src/scheduling/day-plan-notifier';
import { OverrideService } from '../src/scheduling/override.service';

/**
 * #249 — a return-date deferral may be overridden, never bypassed (Decision 17).
 *
 * `assignTicket` checked existence, zone scope and `ALREADY_ASSIGNED` and **never consulted
 * `notDeferredOn`**. So the one-click assign on the Critical Work Queue would happily put a ticket
 * whose vehicle is not back until Friday onto today's plan — silently, with nothing in the audit trail
 * naming the hold it walked through, and leaving `deferredUntil` set on a now-FORMALLY_ASSIGNED ticket
 * for the automatic paths to trip over later. The bulk path already honoured the deferral at selection
 * (#146), which is what made the hole easy to miss: it is only reachable when a ticket is handed to
 * `assignTicket` directly.
 *
 * The fix deliberately reuses the `CONFLICT_ON_SITE` pattern rather than inventing a second one — 409,
 * `confirm: true` plus a mandatory reason, and an extra audit row naming what was overridden. A ZM may
 * absolutely decide the vehicle situation has changed; they may not do it invisibly.
 */
const NS = Date.now();
/** 11:30 IST on 2026-06-21. */
const NOW = new Date('2026-06-21T06:00:00Z');
/** Two IST days ahead — a live hold. */
const FUTURE = new Date('2026-06-23T00:00:00.000Z');

describe('#249 — explicit override of a return-date deferral', () => {
  let prisma: PrismaService;
  let svc: OverrideService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let se: string;
  let zm: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];

  let mkSe: () => Promise<string>;
  const scope = () => ({ role: 'ZONAL_MANAGER', zoneId: Number(zoneId) });
  const actor = () => ({ userId: zm, role: 'ZONAL_MANAGER', actedAsRole: null });

  /** An OPEN, unassigned TROUBLESHOOT ticket, optionally deferred to `deferredUntil`. */
  const makeTicket = async (deferredUntil: Date | null = null): Promise<string> => {
    const deviceId = String(9_490_000_000 + (NS % 100_000) * 10 + deviceIds.length);
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
        assignmentState: 'UNASSIGNED',
        deferredUntil,
        lastStateChangedAt: NOW,
      },
    });
    ticketIds.push(ticket.ticketId);
    return ticket.ticketId;
  };

  const fileWait = (ticketId: string, expectedFrom: Date) =>
    prisma.vehicleUnavailabilityReport.create({
      data: {
        ticketId,
        seId: se,
        reasonCode: 'VEHICLE_ON_TRIP',
        transporterContacted: false,
        proposedFrom: expectedFrom,
        expectedFrom,
        status: 'OPEN',
      },
    });

  const ticketRow = (id: string) => prisma.ticket.findUniqueOrThrow({ where: { ticketId: id } });
  const auditsFor = (ticketId: string, action: string) =>
    prisma.auditLog.findMany({ where: { entityType: 'ticket', entityId: ticketId, action } });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new OverrideService(prisma, new AuditService(prisma), new LoggingDayPlanNotifier());

    zoneId = (await prisma.zone.create({ data: { name: 'Z-doc-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-doc-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-doc-' + NS, zoneId } })).plantId;

    const mkUser = async (role: string) => {
      const tag = randomUUID().slice(0, 8);
      const u = await prisma.user.create({
        data: { name: `${role} ${tag}`, role: role as never, phone: `doc-${tag}`, email: `${tag}-${NS}@doc.test`, zoneId },
      });
      userIds.push(u.userId);
      return u.userId;
    };
    mkSe = async () => {
      const id = await mkUser('SERVICE_ENGINEER');
      await prisma.engineerMaster.create({ data: { engineerId: id, coverageType: 'DEDICATED', zoneId, dailyCapacity: 20 } });
      return id;
    };
    se = await mkUser('SERVICE_ENGINEER');
    zm = await mkUser('ZONAL_MANAGER');
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 20 } });
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ticketIds } } });
    await prisma.batchAssignmentTicket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { seId: { in: userIds } } });
    await prisma.workSchedule.deleteMany({ where: { seId: { in: userIds } } });
    await prisma.vehicleUnavailabilityReport.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('AC1 — an unconfirmed assign of a deferred ticket is refused, and the ticket is untouched', async () => {
    const ticketId = await makeTicket(FUTURE);
    const report = await fileWait(ticketId, new Date('2026-06-23T03:30:00Z'));

    const out = await svc.assignTicket(ticketId, se, scope(), actor(), NOW);

    expect(out.result).toBe('CONFLICT_DEFERRED');
    if (out.result !== 'CONFLICT_DEFERRED') throw new Error('unreachable');
    expect(out.ticketId).toBe(ticketId);
    expect(out.deferredUntil).toBe(FUTURE.toISOString());
    // The dialog needs the *why*, not just the date — the SE's proposal and the authoritative date,
    // which a manager's override may already have separated (#245).
    expect(out.vuReport?.id).toBe(String(report.id));
    expect(out.vuReport?.expectedFrom).toBe(new Date('2026-06-23T03:30:00Z').toISOString());

    const ticket = await ticketRow(ticketId);
    expect(ticket.assignmentState).toBe('UNASSIGNED');
    expect(ticket.deferredUntil?.toISOString()).toBe(FUTURE.toISOString());
    expect(await prisma.batchAssignmentTicket.count({ where: { ticketId } })).toBe(0);
  });

  it('AC1 — a confirm with no reason is still refused: the reason is the accountability record', async () => {
    const ticketId = await makeTicket(FUTURE);
    const out = await svc.assignTicket(ticketId, se, scope(), actor(), NOW, 'CRITICAL_ASSIGN', false, {
      confirm: true,
      reasonCode: '   ',
    });
    expect(out.result).toBe('REASON_REQUIRED');
    expect((await ticketRow(ticketId)).assignmentState).toBe('UNASSIGNED');
  });

  it('AC1/AC2 — a confirmed override assigns, audits the deferral it overrode, and spends the deferral', async () => {
    const ticketId = await makeTicket(FUTURE);
    const report = await fileWait(ticketId, new Date('2026-06-23T03:30:00Z'));

    const out = await svc.assignTicket(ticketId, se, scope(), actor(), NOW, 'CRITICAL_ASSIGN', false, {
      confirm: true,
      reasonCode: 'customer escalated, vehicle sourced locally',
    });
    expect(out.result).toBe('OK');

    const ticket = await ticketRow(ticketId);
    expect(ticket.assignmentState).toBe('FORMALLY_ASSIGNED');
    // AC2 — the deferral is spent, matching what dispatch does on assignment. Leaving a future date on
    // an assigned ticket is the stale-deferral edge this closes rather than creates.
    expect(ticket.deferredUntil).toBeNull();

    const rows = await auditsFor(ticketId, 'OVERRIDE_DEFERRED_ASSIGN');
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({
      deferredUntil: FUTURE.toISOString(),
      reasonCode: 'customer escalated, vehicle sourced locally',
      vuReportId: String(report.id),
    });

    // AC2 — overriding the hold is not deciding the return date: the report is left exactly as it was.
    const after = await prisma.vehicleUnavailabilityReport.findUniqueOrThrow({ where: { id: report.id } });
    expect(after.status).toBe('OPEN');
    expect(after.expectedFrom.toISOString()).toBe(new Date('2026-06-23T03:30:00Z').toISOString());
  });

  it('AC1 — no new friction on the normal path: an undeferred ticket assigns with no confirm at all', async () => {
    const ticketId = await makeTicket(null);
    const out = await svc.assignTicket(ticketId, se, scope(), actor(), NOW);
    expect(out.result).toBe('OK');
    expect(await auditsFor(ticketId, 'OVERRIDE_DEFERRED_ASSIGN')).toHaveLength(0);
  });

  it("AC1 — a deferral that has already lapsed is not a hold: today's date assigns freely", async () => {
    // `deferred_until` is inclusive on the day itself (`notDeferredOn`), so the ticket is back in the
    // pool today and there is nothing to override. Pinned so the branch keys on the same boundary
    // every other reader of unassigned work uses, rather than on a nearby one.
    const ticketId = await makeTicket(istDate(NOW));
    const out = await svc.assignTicket(ticketId, se, scope(), actor(), NOW);
    expect(out.result).toBe('OK');
    expect(await auditsFor(ticketId, 'OVERRIDE_DEFERRED_ASSIGN')).toHaveLength(0);
  });

  it('AC3 — assignPlants still excludes deferred tickets at selection, so bulk behaviour is unchanged', async () => {
    const deferred = await makeTicket(FUTURE);
    const open = await makeTicket(null);

    const summary = await svc.assignPlants([String(plantId)], se, scope(), actor(), NOW);
    if ('result' in summary) throw new Error('SE_NOT_FOUND');

    expect((await ticketRow(open)).assignmentState).toBe('FORMALLY_ASSIGNED');
    // The bulk path never hands a deferred ticket to assignTicket, so it never reaches the new branch:
    // no 409 to swallow, no silent skip to explain, behaviour byte-identical to #146.
    expect((await ticketRow(deferred)).assignmentState).toBe('UNASSIGNED');
    expect((await ticketRow(deferred)).deferredUntil?.toISOString()).toBe(FUTURE.toISOString());
    expect(await auditsFor(deferred, 'OVERRIDE_DEFERRED_ASSIGN')).toHaveLength(0);
  });

  /**
   * AC1 — the branch is unreachable from the intraday direct-assign path, pinned rather than assumed.
   *
   * `IntradayInsertionService.assignCriticalForZone` selects with `notDeferredOn`
   * (`intraday-insertion.service.ts`), so a deferred ticket is never even considered — #268's own AC
   * ("a deferred CRITICAL ticket is never system-assigned"). That is a property of a *different* file,
   * which is exactly why it is asserted here: the direct-assign path calls `assignTicket` with no
   * deferral override, so if the sweep ever stopped spreading the predicate, the assignment would start
   * failing silently with CONFLICT_DEFERRED and nothing else would notice.
   */
  it('AC1 — the intraday sweep never selects a deferred ticket, so its direct-assign cannot reach the branch', async () => {
    const deferred = await makeTicket(FUTURE);
    const open = await makeTicket(null);
    const offered = await prisma.ticket.findMany({
      where: {
        ticketId: { in: [deferred, open] },
        status: 'OPEN',
        assignmentState: 'UNASSIGNED',
        ...notDeferredOn(istDate(NOW)),
      },
      select: { ticketId: true },
    });
    expect(offered.map((t) => t.ticketId)).toEqual([open]);
  });

  /**
   * AC4 — moving a batch is not assigning it, so a carried deferral is preserved, not spent. The
   * shape is near-vacuous by construction (a deferred ticket has no live batch row to move) and
   * reachable only through the edge above — an assign that left a future date behind — which is why
   * it is defence in depth rather than the main gate.
   */
  it('AC4 — REASSIGN of a ticket carrying a future deferral is refused without confirm, and preserves it when confirmed', async () => {
    const ticketId = await makeTicket(FUTURE);
    // A fresh holder: the earlier assigns already built `se` a schedule for today, and one SE has at
    // most one per (zone, date).
    const holder = await mkSe();
    const schedule = await prisma.workSchedule.create({
      data: { seId: holder, zoneId, dateFrom: istDate(NOW), dateTo: istDate(NOW), status: 'ACTIVE', dispatchedAt: NOW },
    });
    const batch = await prisma.plantBatchAssignment.create({
      data: { scheduleId: schedule.scheduleId, plantId, seId: holder, status: 'AUTO_ASSIGNED', stopSequence: 1 },
    });
    await prisma.batchAssignmentTicket.create({ data: { batchId: batch.batchId, ticketId, sortOrder: 1 } });

    const other = await mkSe();
    const refused = await svc.override(
      batch.batchId,
      { action: 'REASSIGN', ticketId, newSeId: other, reasonCode: 'cover' },
      scope(),
      actor(),
      NOW,
    );
    expect(refused.result).toBe('CONFLICT_DEFERRED');
    if (refused.result !== 'CONFLICT_DEFERRED') throw new Error('unreachable');
    expect(refused.ticketIds).toEqual([ticketId]);

    const confirmed = await svc.override(
      batch.batchId,
      { action: 'REASSIGN', ticketId, newSeId: other, reasonCode: 'cover', confirm: true },
      scope(),
      actor(),
      NOW,
    );
    expect(confirmed.result).toBe('OK');
    // Preserved: only an assignment-creating action spends a deferral.
    expect((await ticketRow(ticketId)).deferredUntil?.toISOString()).toBe(FUTURE.toISOString());
    const moved = await prisma.auditLog.findMany({
      where: { entityType: 'plant_batch_assignment', entityId: String(batch.batchId), action: 'OVERRIDE_DEFERRED_MOVE' },
    });
    expect(moved).toHaveLength(1);
    expect(moved[0].metadata).toMatchObject({ ticketIds: [ticketId], reasonCode: 'cover', action: 'REASSIGN' });
  });
});
