import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { DispatchRunService } from '../src/scheduling/dispatch-run.service';
import { SchedulerPreviewService } from '../src/scheduling/scheduler-preview.service';

/**
 * #251 — the Scheduler Preview service: the projection an admin reads, and the one pre-run lever
 * they have over it.
 *
 * **What a hold is, and what it deliberately is not.** Admin approval is never required (Decision
 * 1/18) — inaction means the 05:00 run proceeds exactly as if nobody looked. So a hold is not an
 * approval gate; it is a date on a ticket that the existing `notDeferredOn` predicate already
 * respects. It is also the *only* pre-run change, because it is the only one the current data model
 * expresses: anything richer would invent pre-run assignment state the run would then have to honour,
 * which is a second scheduling authority.
 *
 * **Why a new writer was needed at all.** The existing hold writer, `DEFER_TICKET`, requires a live
 * `batch_assignment_tickets` row — it defers work *off a day plan*. An undispatched ticket has no such
 * row, so before this an unassigned ticket simply could not be held.
 *
 * The inclusivity of `deferred_until` is the sharp edge here and is asserted directly:
 * `notDeferredOn(day)` admits `deferred_until <= day`, so a ticket held "until D" **is** dispatchable
 * on D, and holding it off D means naming D+1.
 */
const NS = Date.now();
const NOW = new Date('2026-06-21T06:00:00Z');
const D1 = new Date('2026-06-22T00:00:00Z'); // the IST day after NOW's
const D2 = new Date('2026-06-23T00:00:00Z');

describe('#251 — scheduler preview + pre-run holds', () => {
  let prisma: PrismaService;
  let svc: SchedulerPreviewService;

  let zoneId: bigint;
  let otherZoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let se: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  let ticketA: string;

  const OH = { role: 'OPERATIONS_HEAD', zoneId: null as number | null };
  const actor = { userId: '33333333-3333-3333-3333-333333333333', role: 'OPERATIONS_HEAD', actedAsRole: null };

  const countAll = async () => ({
    recommendations: await prisma.recommendation.count(),
    schedules: await prisma.workSchedule.count(),
    batchTickets: await prisma.batchAssignmentTicket.count(),
    runs: await prisma.dispatchRun.count(),
  });

  const makeTicket = async (): Promise<string> => {
    const deviceId = String(12_700_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        hasOpenFailureCycle: true,
        inactivityHours: 48,
        latestGpsDatetime: new Date(NOW.getTime() - 48 * 3_600_000),
        plantId,
        companyId,
        computedAt: NOW,
      },
    });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
    const t = await prisma.ticket.create({
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
    ticketIds.push(t.ticketId);
    return t.ticketId;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    const runs = new DispatchRunService(
      prisma,
      new RecommenderService(prisma, new CandidateSelectionService(prisma)),
      new BatchAssignmentService(prisma),
    );
    svc = new SchedulerPreviewService(prisma, runs, new AuditService(prisma));

    zoneId = (await prisma.zone.create({ data: { name: 'Z-sp-' + NS } })).zoneId;
    otherZoneId = (await prisma.zone.create({ data: { name: 'Z-sp2-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-sp-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-sp-' + NS, zoneId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@sp.test`, zoneId },
    });
    userIds.push(u.userId);
    se = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
    await prisma.seCoverage.create({ data: { seId: se, plantId, coverageType: 'DEDICATED' } });

    ticketA = await makeTicket();
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { entityType: 'ticket', entityId: { in: ticketIds } } });
    await prisma.vehicleUnavailabilityReport.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seCoverage.deleteMany({ where: { plantId } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: [zoneId, otherZoneId] } } });
    await prisma.onModuleDestroy();
  });

  /** AC-1 — the projection is a read. Count-pinned here as well as in #250, at the service boundary. */
  it('AC-1: previewing writes nothing and returns the projected plan', async () => {
    const before = await countAll();
    const preview = await svc.preview(D1, OH, NOW);
    const after = await countAll();

    expect(after).toEqual(before);
    expect(preview.targetDate).toBe('2026-06-22');
    const zone = preview.zones.find((z) => z.zoneId === String(zoneId));
    expect(zone).toBeDefined();
    expect(zone!.recommended).toBe(1);
    expect(zone!.plan).toEqual([{ seId: se, plants: [{ plantId: String(plantId), ticketIds: [ticketA] }] }]);
    // AC-6's data half — the caveat cannot be rendered without the watermark.
    expect(preview.bucketsAsOf).toBe(NOW.toISOString());
  });

  /**
   * AC-2 — the hold excludes the ticket from the target day's run *through the existing predicate*,
   * not through a preview-only filter. Proven by the projection changing, since the projection is the
   * real recommender.
   */
  it('AC-2: a hold removes the ticket from the held day and release restores it', async () => {
    // Held "until D2" ⇒ absent on D1, present again on D2 — `notDeferredOn` is inclusive on D2.
    const held = await svc.placeHold(ticketA, D2, 'AWAITING_PARTS', OH, actor);
    expect(held.result).toBe('OK');
    expect(held.result === 'OK' && held.heldUntil).toBe('2026-06-23');

    const d1 = await svc.preview(D1, OH, NOW);
    expect(d1.zones.find((z) => z.zoneId === String(zoneId))!.decisions).toHaveLength(0);
    expect(d1.holds.map((h) => h.ticketId)).toContain(ticketA);

    const d2 = await svc.preview(D2, OH, NOW);
    expect(d2.zones.find((z) => z.zoneId === String(zoneId))!.decisions.map((d) => d.ticketId)).toContain(ticketA);
    // The hold is no longer "in force" for a day it does not hold.
    expect(d2.holds.map((h) => h.ticketId)).not.toContain(ticketA);

    const released = await svc.releaseHold(ticketA, OH, actor);
    expect(released.result).toBe('OK');
    const after = await svc.preview(D1, OH, NOW);
    expect(after.zones.find((z) => z.zoneId === String(zoneId))!.decisions.map((d) => d.ticketId)).toContain(ticketA);
  });

  /** AC-2 — both writes are audited with the reason, so a hold is never an anonymous date change. */
  it('AC-2: hold and release are audited with reason and previous value', async () => {
    await svc.placeHold(ticketA, D2, 'PLANNED_SITE_CLOSURE', OH, actor);
    await svc.releaseHold(ticketA, OH, actor);

    const rows = await prisma.auditLog.findMany({
      where: { entityType: 'ticket', entityId: ticketA, action: { in: ['SCHEDULER_HOLD_PLACED', 'SCHEDULER_HOLD_RELEASED'] } },
      orderBy: { id: 'asc' },
    });
    const placed = rows.filter((r) => r.action === 'SCHEDULER_HOLD_PLACED').pop()!;
    const releasedRow = rows.filter((r) => r.action === 'SCHEDULER_HOLD_RELEASED').pop()!;
    expect((placed.metadata as Record<string, unknown>).reasonCode).toBe('PLANNED_SITE_CLOSURE');
    expect((placed.metadata as Record<string, unknown>).heldUntil).toBe('2026-06-23');
    expect((releasedRow.metadata as Record<string, unknown>).releasedFrom).toBe('2026-06-23');
  });

  /**
   * AC-4 — Decision 13: a hold and a vehicle-return date are different concepts sharing one column.
   * A hold is an admin's scheduling preference; a return date is an operational fact about a vehicle.
   * Silently overwriting the second with the first loses information nobody can recover.
   */
  it('AC-4: a hold refuses to overwrite a vehicle-return deferral unless confirmed', async () => {
    const report = await prisma.vehicleUnavailabilityReport.create({
      data: {
        ticketId: ticketA,
        seId: se,
        reasonCode: 'VEHICLE_ON_TRIP',
        expectedFrom: D2,
        status: 'OPEN',
      },
    });

    const refused = await svc.placeHold(ticketA, D2, 'ADMIN_HOLD', OH, actor);
    expect(refused.result).toBe('CONFLICT_VEHICLE_UNAVAILABLE');
    expect(refused.result === 'CONFLICT_VEHICLE_UNAVAILABLE' && refused.reportId).toBe(String(report.id));
    // Refused means refused — the column is untouched, not "refused but written anyway".
    expect((await prisma.ticket.findUniqueOrThrow({ where: { ticketId: ticketA } })).deferredUntil).toBeNull();

    const confirmed = await svc.placeHold(ticketA, D2, 'ADMIN_HOLD', OH, actor, { confirm: true });
    expect(confirmed.result).toBe('OK');
    // The override is recorded — the one case where this write destroys information.
    const audit = await prisma.auditLog.findFirst({
      where: { entityType: 'ticket', entityId: ticketA, action: 'SCHEDULER_HOLD_PLACED' },
      orderBy: { id: 'desc' },
    });
    expect((audit!.metadata as Record<string, unknown>).overrodeVehicleReport).toBe(String(report.id));

    await svc.releaseHold(ticketA, OH, actor);
    await prisma.vehicleUnavailabilityReport.delete({ where: { id: report.id } });
  });

  /**
   * A dispatched ticket has a live batch row this write would not touch, which would leave it on the
   * SE's day plan while marked deferred. `DEFER_TICKET` exists precisely to do both halves together.
   */
  it('refuses to hold an assigned ticket, pointing at the batch-override path instead', async () => {
    await prisma.ticket.update({ where: { ticketId: ticketA }, data: { assignmentState: 'FORMALLY_ASSIGNED' } });
    const outcome = await svc.placeHold(ticketA, D2, 'ADMIN_HOLD', OH, actor);
    expect(outcome.result).toBe('NOT_HOLDABLE');
    expect(outcome.result === 'NOT_HOLDABLE' && outcome.assignmentState).toBe('FORMALLY_ASSIGNED');
    await prisma.ticket.update({ where: { ticketId: ticketA }, data: { assignmentState: 'UNASSIGNED' } });
  });

  /** Read scope: a ZM sees their own zone only — the codebase's uniform model, applied server-side. */
  it('scopes a ZM to their own zone and refuses out-of-zone holds', async () => {
    const zm = { role: 'ZONAL_MANAGER', zoneId: Number(otherZoneId) };
    const preview = await svc.preview(D1, zm, NOW);
    expect(preview.zones.every((z) => z.zoneId !== String(zoneId))).toBe(true);

    const outcome = await svc.placeHold(ticketA, D2, 'ADMIN_HOLD', zm, actor);
    expect(outcome.result).toBe('NOT_FOUND');
  });

  /**
   * AC-5 — staleness. The scheduler preview never *executes*, so unlike bulk-unassign's token this one
   * guards a display: its job is to tell the admin the plan on screen is no longer the plan.
   */
  it('AC-5: a token is FRESH until the world moves, then TOKEN_STALE with a fresh projection', async () => {
    const preview = await svc.preview(D1, OH, NOW);
    expect((await svc.checkStaleness(preview.previewToken, OH, NOW)).result).toBe('FRESH');

    // Move the world: hold the only dispatchable ticket, so the zone's counts change.
    await svc.placeHold(ticketA, D2, 'AWAITING_PARTS', OH, actor);
    const stale = await svc.checkStaleness(preview.previewToken, OH, NOW);
    expect(stale.result).toBe('TOKEN_STALE');
    expect(stale.result === 'TOKEN_STALE' && stale.freshPreview.zones.find((z) => z.zoneId === String(zoneId))!.recommended).toBe(0);

    expect((await svc.checkStaleness('not-a-token', OH, NOW)).result).toBe('TOKEN_INVALID');
    await svc.releaseHold(ticketA, OH, actor);
  });
});
