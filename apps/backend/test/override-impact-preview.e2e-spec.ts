import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { LoggingDayPlanNotifier } from '../src/scheduling/day-plan-notifier';
import { OverrideProjectionService } from '../src/scheduling/override-projection.service';
import { OverrideService } from '../src/scheduling/override.service';

/**
 * #289 — the missing middle of the approved flow.
 *
 * The design's step 3 is **inspect → understand → override → preview impact → confirm**, and the
 * system had the first three and the last one. Every override commits immediately (reason-gated, but
 * with no projection), so the operator's only way to see what a move would do was to do it.
 *
 * The pattern this copies is proven: `distribute-projection.service.ts` (#276) contains no
 * `create`/`update` at all, and #250's dry-run seam suppresses all six mutations. The load-bearing
 * property here is the same one — **the preview writes nothing** — and it is asserted the only way
 * worth asserting it: by counting rows across every table a real move touches, before and after.
 */
const NS = Date.now();

describe('#289 — override impact preview (e2e)', () => {
  let prisma: PrismaService;
  let rec: RecommenderService;
  let dispatch: BatchAssignmentService;
  let override: OverrideService;
  let projection: OverrideProjectionService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let otherPlantId: bigint;
  let fromSe: string;
  let toSe: string;
  let batchId: bigint;
  let runId: bigint;
  let movedTicket: string;
  let keptTicket: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  const ZM = { userId: '11111111-1111-1111-1111-111111111111', role: 'ZONAL_MANAGER', actedAsRole: null };
  const NOW = new Date('2026-06-24T06:00:00Z');
  const scope = { role: 'ZONAL_MANAGER', zoneId: 0 };

  const makeTicket = async (plant: bigint, gpsAgeMin: number): Promise<string> => {
    const deviceId = String(10_890_000_000 + (NS % 100_000) * 10 + deviceIds.length);
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

  const makeSe = async (capacity: number): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@oip.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({
      data: { engineerId: u.userId, coverageType: 'MULTI_PLANT', zoneId, dailyCapacity: capacity },
    });
    return u.userId;
  };

  /** Every table a real move writes to — the population AC2's "writes nothing" is measured over. */
  const snapshotCounts = async () => ({
    schedules: await prisma.workSchedule.count({ where: { zoneId } }),
    batches: await prisma.plantBatchAssignment.count({ where: { schedule: { zoneId } } }),
    batchTickets: await prisma.batchAssignmentTicket.count({ where: { batch: { schedule: { zoneId } } } }),
    audits: await prisma.auditLog.count({ where: { entityType: 'plant_batch_assignment' } }),
    outbox: await prisma.dayPlanNotificationOutbox.count({ where: { zoneId } }),
    liveRows: await prisma.batchAssignmentTicket.count({
      where: { batch: { schedule: { zoneId } }, removedAt: null },
    }),
  });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    rec = new RecommenderService(prisma, new CandidateSelectionService(prisma));
    dispatch = new BatchAssignmentService(prisma);
    override = new OverrideService(prisma, new AuditService(prisma), new LoggingDayPlanNotifier());
    projection = new OverrideProjectionService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-oip-' + NS } })).zoneId;
    scope.zoneId = Number(zoneId);
    companyId = (
      await prisma.company.create({ data: { name: 'Co-oip-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-oip-' + NS, zoneId } })).plantId;
    otherPlantId = (await prisma.plant.create({ data: { name: 'P-oip2-' + NS, zoneId } })).plantId;

    // Capacities chosen so the move visibly changes both sides and takes the target TO its cap —
    // the design's own `5/6 → 6/6`, which is the case an operator most needs stated before committing.
    fromSe = await makeSe(8);
    toSe = await makeSe(6);
    for (const p of [plantId, otherPlantId]) {
      await prisma.seCoverage.create({ data: { seId: fromSe, plantId: p, coverageType: 'MULTI_PLANT' } });
      await prisma.seCoverage.create({ data: { seId: toSe, plantId: p, coverageType: 'MULTI_PLANT' } });
    }

    movedTicket = await makeTicket(plantId, 300); // oldest → placed first
    keptTicket = await makeTicket(plantId, 100);

    // Dispatched **through a real run**, because the rank context this issue adds is read from that
    // run's own decision traces — and traces are only written when a run id is threaded through. A
    // fixture that dispatched run-less would test the projection against a world the engine never
    // produces, and would have quietly proved only that "no run means no rank".
    runId = (
      await prisma.dispatchRun.create({
        data: { trigger: 'CRON', status: 'SUCCESS', startedAt: NOW, finishedAt: NOW, configSnapshot: {} },
      })
    ).runId;
    await rec.runForZone(zoneId, { now: NOW, runId });
    await dispatch.dispatchForZone(zoneId, { dateFrom: NOW, dateTo: NOW, now: NOW, runId });

    const batch = await prisma.plantBatchAssignment.findFirstOrThrow({ where: { plantId } });
    batchId = batch.batchId;
    // The engine picks whichever engineer it ranks first, and which one that is must not decide what
    // this spec asserts. Roles are assigned from the outcome and the caps are set afterwards, so the
    // fixture reads the same whichever way the run went: source cap 8, target cap 6 — the design's own
    // `5/6 → 6/6` shape, where the move takes the target exactly to their cap.
    fromSe = batch.seId;
    toSe = userIds.find((u) => u !== fromSe && u !== ZM.userId)!;
    await prisma.engineerMaster.update({ where: { engineerId: fromSe }, data: { dailyCapacity: 8 } });
    await prisma.engineerMaster.update({ where: { engineerId: toSe }, data: { dailyCapacity: 6 } });
  });

  afterAll(async () => {
    const schedules = await prisma.workSchedule.findMany({ where: { zoneId }, select: { scheduleId: true } });
    const batches = await prisma.plantBatchAssignment.findMany({
      where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } },
      select: { batchId: true },
    });
    await prisma.dayPlanNotificationOutbox.deleteMany({ where: { zoneId } });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.workSchedule.deleteMany({ where: { zoneId } });
    await prisma.auditLog.deleteMany({ where: { entityType: 'plant_batch_assignment', entityId: String(batchId) } });
    await prisma.dispatchDecisionTrace.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seCoverage.deleteMany({ where: { plantId: { in: [plantId, otherPlantId] } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [plantId, otherPlantId] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.dispatchRunZone.deleteMany({ where: { runId } });
    await prisma.dispatchRun.deleteMany({ where: { runId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  /**
   * AC1 — the four things the design's step-3 panel shows, in one answer.
   *
   * Capacity is read through `committedDayPlan`, the same function the engine enforces against
   * (#269 / #272 R9), so the panel and the run can never disagree about what "committed" means — the
   * whole reason three counters were collapsed into one.
   */
  it('AC1 — returns both lanes capacity before/after, rank context, stop-order effect and conflicts', async () => {
    const impact = await projection.projectOverride(
      batchId,
      { action: 'REASSIGN', ticketId: movedTicket, newSeId: toSe, reasonCode: 'CLOSER_SE' },
      scope,
      NOW,
    );

    expect(impact.result).toBe('OK');
    if (impact.result !== 'OK') return;

    expect(impact.from.seId).toBe(fromSe);
    expect(impact.to.seId).toBe(toSe);
    // Two tickets committed to the source; the move takes one away and gives it to the target.
    expect(impact.from.committed).toBe(2);
    expect(impact.from.after).toBe(1);
    expect(impact.to.committed).toBe(0);
    expect(impact.to.after).toBe(1);
    expect(impact.from.dailyCapacity).toBe(8);

    // Rank context — "who did the run think should have this ticket, and where did the target sit?"
    expect(impact.rank).not.toBeNull();
    expect(impact.rank?.ticketId).toBe(movedTicket);
    expect(impact.rank?.runId).toBe(String(runId));
    expect(impact.rank?.chosenSeId).toBe(fromSe);
    // The target was in the pool the run compared, so it can say where — this is the sentence the
    // design's "System view" line renders.
    expect(impact.rank?.targetPrecedenceRank).not.toBeNull();

    // The route is appended, never reordered — the design says so in words and this pins it.
    expect(impact.route.reordersExistingStops).toBe(false);
    expect(impact.route.appendedAsStop).toBeGreaterThanOrEqual(1);

    expect(impact.conflicts.onSite).toEqual([]);
    expect(impact.conflicts.deferred).toEqual([]);
  });

  /**
   * AC2 — **the load-bearing property**. Counted across every table a real move writes, because a
   * projection that quietly created a schedule row would be indistinguishable from a working preview
   * right up until an operator cancelled and found the plan already changed.
   */
  it('AC2 — the preview writes nothing, across every table a real move touches', async () => {
    const before = await snapshotCounts();

    await projection.projectOverride(
      batchId,
      { action: 'REASSIGN', ticketId: movedTicket, newSeId: toSe, reasonCode: 'CLOSER_SE' },
      scope,
      NOW,
    );
    await projection.projectOverride(
      batchId,
      { action: 'SWAP_SE', newSeId: toSe, reasonCode: 'SE_SICK' },
      scope,
      NOW,
    );
    await projection.projectOverride(
      batchId,
      { action: 'SPLIT_BATCH', ticketIds: [movedTicket, keptTicket], newSeId: toSe, reasonCode: 'LOAD_BALANCE' },
      scope,
      NOW,
    );

    expect(await snapshotCounts()).toEqual(before);
  });

  /** A whole-batch swap moves everything, so the source empties and the target takes the lot. */
  it('AC1 — a SWAP_SE projects the whole batch onto the target', async () => {
    const impact = await projection.projectOverride(
      batchId,
      { action: 'SWAP_SE', newSeId: toSe, reasonCode: 'SE_SICK' },
      scope,
      NOW,
    );

    expect(impact.result).toBe('OK');
    if (impact.result !== 'OK') return;
    expect(impact.ticketIds.sort()).toEqual([movedTicket, keptTicket].sort());
    expect(impact.from.after).toBe(0);
    expect(impact.to.after).toBe(2);
  });

  /**
   * Over capacity is **stated, never a refusal** (#258 Q2). The projection's job is to make the
   * decision a seen one; refusing here would turn a preview into the gate the ruling forbids.
   */
  it('AC1 — a move that takes the target past their cap says so, and still projects', async () => {
    // Give the target a full day elsewhere first, so one more ticket puts them over their cap of 6.
    const filler: string[] = [];
    for (let i = 0; i < 6; i++) filler.push(await makeTicket(otherPlantId, 400 + i));
    for (const t of filler) {
      await override.assignTicket(t, toSe, scope, ZM, NOW);
    }

    const impact = await projection.projectOverride(
      batchId,
      { action: 'REASSIGN', ticketId: movedTicket, newSeId: toSe, reasonCode: 'CLOSER_SE' },
      scope,
      NOW,
    );

    expect(impact.result).toBe('OK');
    if (impact.result !== 'OK') return;
    expect(impact.to.committed).toBe(6);
    expect(impact.to.after).toBe(7);
    expect(impact.to.overCapacity).toBe(true);
  });

  /** A batch outside the ZM's zone is not previewable either — the clamp is the same one the write uses. */
  it('a ZM cannot preview a move in another zone', async () => {
    const impact = await projection.projectOverride(
      batchId,
      { action: 'REASSIGN', ticketId: movedTicket, newSeId: toSe, reasonCode: 'CLOSER_SE' },
      { role: 'ZONAL_MANAGER', zoneId: Number(zoneId) + 9999 },
      NOW,
    );
    expect(impact.result).toBe('NOT_FOUND');
  });

  /**
   * A projection for an action that does not move work between engineers is refused rather than
   * answered with an empty impact: "both lanes' capacity" has no meaning for a REMOVE, and returning
   * zeros would read as "this move costs nothing".
   */
  it('refuses to project an action that moves nothing between engineers', async () => {
    const impact = await projection.projectOverride(
      batchId,
      { action: 'REMOVE_TICKET', ticketId: movedTicket, reasonCode: 'NOT_NEEDED' },
      scope,
      NOW,
    );
    expect(impact.result).toBe('NOT_PROJECTABLE');
  });

  /**
   * Null rank is **unknown, never "unranked"** — the same rule #283's provenance follows. A ticket no
   * run placed has no engine opinion to report, and inventing a rank of zero or "last" would be read
   * as the engine having considered and rejected the target.
   */
  it('says nothing about rank for a batch no run produced', async () => {
    const handMade = await prisma.plantBatchAssignment.findFirstOrThrow({ where: { plantId } });
    await prisma.plantBatchAssignment.update({ where: { batchId: handMade.batchId }, data: { runId: null } });
    await prisma.workSchedule.updateMany({ where: { scheduleId: handMade.scheduleId }, data: { runId: null } });

    const impact = await projection.projectOverride(
      batchId,
      { action: 'REASSIGN', ticketId: movedTicket, newSeId: toSe, reasonCode: 'CLOSER_SE' },
      scope,
      NOW,
    );

    expect(impact.result).toBe('OK');
    if (impact.result !== 'OK') return;
    expect(impact.rank).toBeNull();

    // Restore, so the ordering of the tests above it stays irrelevant.
    await prisma.plantBatchAssignment.update({ where: { batchId: handMade.batchId }, data: { runId } });
    await prisma.workSchedule.updateMany({ where: { scheduleId: handMade.scheduleId }, data: { runId } });
  });

  /** A target engineer who does not exist is the same NOT_FOUND the write returns. */
  it('a move to an unknown engineer is NOT_FOUND, not a crash', async () => {
    const impact = await projection.projectOverride(
      batchId,
      { action: 'REASSIGN', ticketId: movedTicket, newSeId: '00000000-0000-0000-0000-000000000000', reasonCode: 'X' },
      scope,
      NOW,
    );
    expect(impact.result).toBe('NOT_FOUND');
  });
});
