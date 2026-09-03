import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { ADD_SOURCES } from '../src/scheduling/add-source';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { LoggingDayPlanNotifier } from '../src/scheduling/day-plan-notifier';
import { OverrideService } from '../src/scheduling/override.service';
import { REMOVAL_REASONS } from '../src/scheduling/removal-reason';

/**
 * **MOVE_TICKET — the Scheduler Console's cross-day drag.**
 *
 * ## The defect this exists to close
 *
 * Dragging a chip from today's LIVE column onto a future PROJECTED column was wired to
 * `DEFER_TICKET`. A defer *unassigns*: it stamps `removed_at` on the day-plan row, returns the ticket
 * to `UNASSIGNED` and sets `deferred_until`, handing the question of who does the work to the run
 * that will decide on that date. So the gesture "put this on Wednesday for this engineer" was
 * answered by "take it off everybody and reconsider it on Wednesday", and — because a deferred ticket
 * belongs to nobody — it could not appear in the cell it was dropped on. The operator saw the ticket
 * vanish, an `adjusted` badge on the stop it left, and nothing on the day they aimed at.
 *
 * ## What is asserted here
 *
 * Every property the move must have that a defer structurally cannot, plus the two the two operations
 * share, plus the invariant that separates them:
 *
 * 1. today's row is closed and stamped as a **relocation**, not a withdrawal;
 * 2. the target day holds a **live schedule, batch and row** for the named engineer;
 * 3. the ticket is still `FORMALLY_ASSIGNED` and — the invariant that makes it a move — carries **no
 *    `deferred_until`**, which is precisely what a defer would have written;
 * 4. it is live on **exactly one** day, never both;
 * 5. it survives being read back, because the assignment is a row and not a client-side fiction;
 * 6. the **target day's run leaves it alone**, without any new "manual" flag — the recommender selects
 *    `UNASSIGNED`, and this ticket is not;
 * 7. the diagonal (another engineer *and* another day) works in one command;
 * 8. a past target date is refused;
 * 9. **DEFER_TICKET still means what it always meant.**
 */
const NS = Date.now();

describe('MOVE_TICKET — moving a ticket to another operating day', () => {
  let prisma: PrismaService;
  let rec: RecommenderService;
  let dispatch: BatchAssignmentService;
  let override: OverrideService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantA: bigint;
  let plantB: bigint;
  let seOne: string;
  let seTwo: string;

  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];

  const ZM = { userId: '11111111-1111-1111-1111-111111111111', role: 'ZONAL_MANAGER', actedAsRole: null };
  /** 2026-06-21 IST. `istDate` normalises to this UTC midnight, so the day strings below are exact. */
  const NOW = new Date('2026-06-21T06:00:00Z');
  const TODAY = '2026-06-21';
  const TOMORROW = '2026-06-22';
  const YESTERDAY = '2026-06-20';
  const scope = () => ({ role: 'ZONAL_MANAGER', zoneId: Number(zoneId) });

  const makeTicket = async (plant: bigint, gpsAgeMin: number): Promise<string> => {
    const deviceId = String(10_700_000_000 + (NS % 100_000) * 10 + deviceIds.length);
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
        plantId: plant,
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
        plantId: plant,
        companyId,
        companyTier: 'GOLD',
        lastStateChangedAt: NOW,
      },
    });
    ticketIds.push(t.ticketId);
    return t.ticketId;
  };

  const makeSe = async (label: string, plants: bigint[]): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: `SE ${label} ${tag}`, role: 'SERVICE_ENGINEER', phone: `ph-${tag}`, email: `${tag}@md.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({
      data: { engineerId: u.userId, coverageType: 'MULTI_PLANT', zoneId, dailyCapacity: 10 },
    });
    for (const p of plants) {
      await prisma.seCoverage.create({ data: { seId: u.userId, plantId: p, coverageType: 'MULTI_PLANT' } });
    }
    return u.userId;
  };

  /** The live day-plan row for a ticket, with the schedule's day — the shape every assertion needs. */
  const liveRow = async (ticketId: string) =>
    prisma.batchAssignmentTicket.findFirst({
      where: { ticketId, removedAt: null },
      include: { batch: { include: { schedule: true } } },
    });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    rec = new RecommenderService(prisma, new CandidateSelectionService(prisma));
    dispatch = new BatchAssignmentService(prisma);
    override = new OverrideService(prisma, new AuditService(prisma), new LoggingDayPlanNotifier());

    zoneId = (await prisma.zone.create({ data: { name: 'Z-md-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-md-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantA = (await prisma.plant.create({ data: { name: 'P-mdA-' + NS, zoneId } })).plantId;
    plantB = (await prisma.plant.create({ data: { name: 'P-mdB-' + NS, zoneId } })).plantId;

    // Only ONE engineer covers the plants during dispatch, so today's plan is deterministic. The
    // second engineer is created afterwards, purely as a move target for the diagonal case.
    seOne = await makeSe('one', [plantA, plantB]);

    await makeTicket(plantA, 240);
    await makeTicket(plantA, 180);
    await makeTicket(plantB, 120);

    await rec.runForZone(zoneId, { now: NOW });
    await dispatch.dispatchForZone(zoneId, { dateFrom: NOW, dateTo: NOW, now: NOW });

    seTwo = await makeSe('two', [plantA, plantB]);
  });

  afterAll(async () => {
    const schedules = await prisma.workSchedule.findMany({ where: { zoneId }, select: { scheduleId: true } });
    const batches = await prisma.plantBatchAssignment.findMany({
      where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } },
      select: { batchId: true },
    });
    const batchIds = batches.map((b) => b.batchId);
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batchIds } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { batchId: { in: batchIds } } });
    await prisma.workSchedule.deleteMany({ where: { zoneId } });
    await prisma.auditLog.deleteMany({
      where: { entityType: 'plant_batch_assignment', entityId: { in: batchIds.map(String) } },
    });
    await prisma.auditLog.deleteMany({ where: { entityType: 'ticket', entityId: { in: ticketIds } } });
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seCoverage.deleteMany({ where: { seId: { in: userIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [plantA, plantB] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────────
  // The primary case: same engineer, tomorrow.
  // ───────────────────────────────────────────────────────────────────────────────────────────────
  describe('same engineer, a later day', () => {
    let ticketId: string;
    let sourceBatchId: bigint;

    beforeAll(async () => {
      ticketId = ticketIds[0];
      const before = await liveRow(ticketId);
      sourceBatchId = before!.batchId;

      const outcome = await override.override(
        batchOf(before!),
        { action: 'MOVE_TICKET', ticketId, newSeId: seOne, targetDate: TOMORROW, reasonCode: 'PARTS_ARRIVE_TOMORROW' },
        scope(),
        ZM,
        NOW,
      );
      expect(outcome.result).toBe('OK');
      // The response points at the DESTINATION — the day the operator now cares about, and the one
      // the Console focuses. Answering with today's schedule would be the old silence in a new place.
      expect(outcome.result === 'OK' && outcome.movedToDate).toBe(TOMORROW);
      expect(outcome.result === 'OK' && outcome.seId).toBe(seOne);
    });

    it("leaves today's plan, stamped as a relocation and not a withdrawal", async () => {
      const source = await prisma.batchAssignmentTicket.findFirstOrThrow({
        where: { batchId: sourceBatchId, ticketId },
      });
      expect(source.removedAt).not.toBeNull();
      expect(source.removedBy).toBe(ZM.userId);
      // REASSIGNED, not ZM_DEFERRED: the assignment did not end, it moved. #244 reads this as a
      // predicate — an attempt that relocated never ran out, so it must not count as one that did.
      expect(source.removalReason).toBe(REMOVAL_REASONS.REASSIGNED);
      // …and emphatically not a defer's stamp, which is what the old wiring wrote here.
      expect(source.deferredToDate).toBeNull();
    });

    it('lands on a live schedule for the target day, under the named engineer', async () => {
      const row = await liveRow(ticketId);
      expect(row).not.toBeNull();
      expect(row!.batch.seId).toBe(seOne);
      expect(row!.batch.schedule.dateFrom.toISOString().slice(0, 10)).toBe(TOMORROW);
      expect(row!.batch.schedule.dateTo.toISOString().slice(0, 10)).toBe(TOMORROW);
      expect(row!.batch.schedule.status).toBe('ACTIVE');
      // The plant travels with the ticket — a stop is a plant, and the ticket did not change plants.
      expect(row!.batch.plantId).toBe(plantA);
      // Provenance says which axis it moved along; the source row's REASSIGNED says only that it did.
      expect(row!.addSource).toBe(ADD_SOURCES.MANUAL_DAY_MOVE);
      expect(row!.addedBy).toBe(ZM.userId);
      expect(row!.addReason).toBe('PARTS_ARRIVE_TOMORROW');
    });

    it('keeps the ticket assigned, and writes no deferral — the whole difference from a defer', async () => {
      const t = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
      expect(t.assignmentState).toBe('FORMALLY_ASSIGNED');
      // A defer would have set this. That it is null is what makes the ticket *owned* on the target
      // day rather than merely eligible to be reconsidered on it.
      expect(t.deferredUntil).toBeNull();
    });

    it('is live on exactly one day — never on both', async () => {
      const live = await prisma.batchAssignmentTicket.findMany({ where: { ticketId, removedAt: null } });
      expect(live).toHaveLength(1);
      const onToday = await prisma.batchAssignmentTicket.count({
        where: {
          ticketId,
          removedAt: null,
          batch: { schedule: { dateFrom: new Date(`${TODAY}T00:00:00.000Z`) } },
        },
      });
      expect(onToday).toBe(0);
    });

    it("flips the source stop OVERRIDDEN — today's plan really did change", async () => {
      const b = await prisma.plantBatchAssignment.findUniqueOrThrow({ where: { batchId: sourceBatchId } });
      expect(b.status).toBe('OVERRIDDEN');
    });

    it('records the day it moved to in the audit trail', async () => {
      const entry = await prisma.auditLog.findFirstOrThrow({
        where: { entityType: 'plant_batch_assignment', entityId: String(sourceBatchId), action: 'BATCH_OVERRIDE_MOVE_TICKET' },
        orderBy: { id: 'desc' },
      });
      const meta = entry.metadata as Record<string, unknown>;
      expect(meta.targetDate).toBe(TOMORROW);
      expect(meta.fromDate).toBe(TODAY);
      expect(meta.reasonCode).toBe('PARTS_ARRIVE_TOMORROW');
    });

    /**
     * **Scheduler ownership, with no new flag.** The requirement is that a later run must not
     * silently undo a manual placement. It cannot, and the reason is structural rather than defensive:
     * the recommender selects `status: OPEN, assignment_state: UNASSIGNED`, and a moved ticket is
     * `FORMALLY_ASSIGNED`. It is therefore not a candidate on the target day at all.
     *
     * Asserted by actually running the target day's recommender and dispatch, rather than by reading
     * the predicate — the claim is about the engine's behaviour, so the engine is what is run.
     */
    it('survives the target day’s own run — the engine does not re-plan assigned work', async () => {
      const tomorrowNow = new Date('2026-06-22T06:00:00Z');
      const before = await liveRow(ticketId);

      await rec.runForZone(zoneId, { now: tomorrowNow });
      await dispatch.dispatchForZone(zoneId, { dateFrom: tomorrowNow, dateTo: tomorrowNow, now: tomorrowNow });

      const after = await liveRow(ticketId);
      expect(after).not.toBeNull();
      // Same row, same engineer, same day: untouched by a full run over the day it sits on.
      expect(after!.id).toBe(before!.id);
      expect(after!.batch.seId).toBe(seOne);
      expect(after!.batch.schedule.dateFrom.toISOString().slice(0, 10)).toBe(TOMORROW);
      // And still exactly one live row — the run appended to the manual schedule, it did not fork it.
      expect(await prisma.batchAssignmentTicket.count({ where: { ticketId, removedAt: null } })).toBe(1);
      const schedulesTomorrow = await prisma.workSchedule.count({
        where: { zoneId, seId: seOne, dateFrom: new Date(`${TOMORROW}T00:00:00.000Z`), status: { in: ['ACTIVE', 'OVERRIDDEN'] } },
      });
      expect(schedulesTomorrow).toBe(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────────
  // The diagonal, and the refusals.
  // ───────────────────────────────────────────────────────────────────────────────────────────────
  describe('the diagonal, and what is refused', () => {
    it('moves to another engineer AND another day in one command', async () => {
      const ticketId = ticketIds[1];
      const before = await liveRow(ticketId);
      expect(before!.batch.seId).toBe(seOne);

      const outcome = await override.override(
        batchOf(before!),
        { action: 'MOVE_TICKET', ticketId, newSeId: seTwo, targetDate: TOMORROW, reasonCode: 'BALANCE_LOAD' },
        scope(),
        ZM,
        NOW,
      );
      expect(outcome.result).toBe('OK');

      const after = await liveRow(ticketId);
      // Both coordinates the drop named, honoured together — this used to be refused outright.
      expect(after!.batch.seId).toBe(seTwo);
      expect(after!.batch.schedule.dateFrom.toISOString().slice(0, 10)).toBe(TOMORROW);
      expect(after!.batch.schedule.seId).toBe(seTwo);
      const t = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
      expect(t.assignmentState).toBe('FORMALLY_ASSIGNED');
      expect(t.deferredUntil).toBeNull();
    });

    it('refuses a target date that has already passed', async () => {
      const ticketId = ticketIds[2];
      const before = await liveRow(ticketId);

      const outcome = await override.override(
        batchOf(before!),
        { action: 'MOVE_TICKET', ticketId, newSeId: seOne, targetDate: YESTERDAY, reasonCode: 'OOPS' },
        scope(),
        ZM,
        NOW,
      );
      expect(outcome.result).toBe('TARGET_DATE_IN_PAST');

      // Refused means refused: nothing moved, nothing was stamped, the plan is exactly as it was.
      const after = await liveRow(ticketId);
      expect(after!.id).toBe(before!.id);
      expect(after!.batch.schedule.dateFrom.toISOString().slice(0, 10)).toBe(TODAY);
    });

    it('refuses a ticket that is not on the named batch', async () => {
      const before = await liveRow(ticketIds[2]);
      const outcome = await override.override(
        batchOf(before!),
        {
          action: 'MOVE_TICKET',
          ticketId: '00000000-0000-0000-0000-000000000000',
          newSeId: seOne,
          targetDate: TOMORROW,
          reasonCode: 'X',
        },
        scope(),
        ZM,
        NOW,
      );
      expect(outcome.result).toBe('NOT_FOUND');
    });

    it('refuses an engineer that does not exist, without touching the plan', async () => {
      const ticketId = ticketIds[2];
      const before = await liveRow(ticketId);
      const outcome = await override.override(
        batchOf(before!),
        {
          action: 'MOVE_TICKET',
          ticketId,
          newSeId: '00000000-0000-0000-0000-000000000000',
          targetDate: TOMORROW,
          reasonCode: 'X',
        },
        scope(),
        ZM,
        NOW,
      );
      expect(outcome.result).toBe('NOT_FOUND');
      const after = await liveRow(ticketId);
      expect(after!.id).toBe(before!.id);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────────
  // The regression that matters most: defer is still defer.
  // ───────────────────────────────────────────────────────────────────────────────────────────────
  /**
   * The Console's drag no longer reaches `DEFER_TICKET`, but the **typed** Defer action still does,
   * and it must still mean what it has always meant. The two operations are now genuinely different
   * decisions, and this is the assertion that keeps them different: a defer *unassigns* and *holds*,
   * a move *keeps* and *relocates*. If this test and the move tests above ever agree, one of the two
   * operations has been quietly turned into the other.
   */
  it('DEFER_TICKET is untouched: it still unassigns and holds, where MOVE_TICKET assigns and relocates', async () => {
    const ticketId = ticketIds[2];
    const before = await liveRow(ticketId);

    const outcome = await override.override(
      batchOf(before!),
      { action: 'DEFER_TICKET', ticketId, deferredToDate: TOMORROW, reasonCode: 'VEHICLE_AWAY' },
      scope(),
      ZM,
      NOW,
    );
    expect(outcome.result).toBe('OK');

    const t = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    expect(t.assignmentState).toBe('UNASSIGNED');
    expect(t.deferredUntil?.toISOString().slice(0, 10)).toBe(TOMORROW);

    const source = await prisma.batchAssignmentTicket.findFirstOrThrow({
      where: { batchId: before!.batchId, ticketId },
    });
    expect(source.removalReason).toBe(REMOVAL_REASONS.ZM_DEFERRED);
    expect(source.deferredToDate?.toISOString().slice(0, 10)).toBe(TOMORROW);

    // Nobody holds it — the property that makes a deferred ticket unrenderable in an engineer's cell,
    // and therefore the property that made the old drag feel like nothing had happened.
    expect(await prisma.batchAssignmentTicket.count({ where: { ticketId, removedAt: null } })).toBe(0);
  });
});

/** The batch a live day-plan row sits on. Narrow helper so the assertions read as assertions. */
function batchOf(row: { batchId: bigint }): bigint {
  return row.batchId;
}
