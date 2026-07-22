import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { LoggingDayPlanNotifier } from '../src/scheduling/day-plan-notifier';
import { OverrideService } from '../src/scheduling/override.service';

/**
 * Same-day re-run must APPEND new work onto the SE's existing ACTIVE (se, zone, day) schedule, never
 * collide-and-drop. Before this fix a second dispatch of an already-dispatched zone hit
 * `work_schedules_one_active_per_se_zone_day` → the whole-zone tx rolled back and every fresh
 * recommendation was deleted (the "1370 recommended / 1045 dispatched" leak). Now: reuse the schedule,
 * add fresh stops, and dispatch the new tickets — while a ticket already in a LIVE batch is never
 * assigned twice (idempotency guard + the `batch_assignment_tickets_one_active_per_ticket` unique as
 * the final DB backstop). Seam under test: RecommenderService.runForZone + BatchAssignmentService.
 */
const NS = Date.now();

describe('dispatch — same-day re-run appends new work (no drop, idempotent)', () => {
  let prisma: PrismaService;
  let rec: RecommenderService;
  let dispatch: BatchAssignmentService;
  let override: OverrideService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let seId: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  const runIds: bigint[] = [];
  const overriddenBatchIds: bigint[] = [];

  const NOW = new Date('2026-06-21T06:00:00Z');
  const DAY = new Date(Date.UTC(2026, 5, 21));

  const makeTicket = async (gpsAgeMin: number): Promise<string> => {
    const deviceId = String(9_721_000_000 + (NS % 100_000) * 100 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId, isInactive: true, slaBucket: 'CRITICAL', eligibleForUptime: true, hasOpenFailureCycle: true,
        latestGpsDatetime: new Date(NOW.getTime() - gpsAgeMin * 60_000), plantId, companyId, computedAt: NOW,
      },
    });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
    const ticket = await prisma.ticket.create({
      data: { workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: cycle.cycleId, deviceId, plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: NOW },
    });
    ticketIds.push(ticket.ticketId);
    return ticket.ticketId;
  };

  const newRun = async (): Promise<bigint> => {
    const run = await prisma.dispatchRun.create({ data: { trigger: 'MANUAL', startedAt: NOW, configSnapshot: {}, status: 'RUNNING' } });
    runIds.push(run.runId);
    return run.runId;
  };

  const activeAssignmentsFor = (ids: string[]) =>
    prisma.batchAssignmentTicket.findMany({ where: { ticketId: { in: ids }, removedAt: null } });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    rec = new RecommenderService(prisma, new CandidateSelectionService(prisma));
    dispatch = new BatchAssignmentService(prisma);
    override = new OverrideService(prisma, new AuditService(prisma), new LoggingDayPlanNotifier());

    zoneId = (await prisma.zone.create({ data: { name: 'Z-append-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-append-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-append-' + NS, zoneId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({ data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@append.test`, zoneId } });
    userIds.push(u.userId);
    seId = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: seId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
    await prisma.seCoverage.create({ data: { seId, plantId, coverageType: 'DEDICATED' } });
  });

  afterAll(async () => {
    await prisma.dispatchDecisionTrace.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.auditLog.deleteMany({
      where: { entityType: 'plant_batch_assignment', entityId: { in: overriddenBatchIds.map(String) } },
    });
    const schedules = await prisma.workSchedule.findMany({ where: { zoneId }, select: { scheduleId: true } });
    const batches = await prisma.plantBatchAssignment.findMany({ where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } }, select: { batchId: true } });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.workSchedule.deleteMany({ where: { zoneId } });
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.dispatchRunZone.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.dispatchRun.deleteMany({ where: { runId: { in: runIds } } });
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
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('appends new tickets onto the SE existing ACTIVE schedule (one schedule, fresh stops, nothing dropped)', async () => {
    // Run 1 — two tickets dispatched onto a fresh schedule.
    await makeTicket(120);
    await makeTicket(90);
    const run1 = await newRun();
    const rec1 = await rec.runForZone(zoneId, { now: NOW, runId: run1 });
    const out1 = await dispatch.dispatchForZone(zoneId, { dateFrom: DAY, dateTo: DAY, now: NOW, runId: run1 });
    expect(rec1.recommended).toBe(2);
    expect(out1.schedules).toBe(1);
    expect(out1.tickets).toBe(2);
    await prisma.dispatchRun.update({ where: { runId: run1 }, data: { status: 'SUCCESS', finishedAt: NOW } });

    const scheduleAfter1 = await prisma.workSchedule.findMany({ where: { zoneId, seId, status: 'ACTIVE' } });
    expect(scheduleAfter1).toHaveLength(1);
    const scheduleId = scheduleAfter1[0].scheduleId;

    // A third ticket arrives after the morning plan — the exact "new backlog on a same-day re-run" case.
    const newTicket = await makeTicket(45);

    // Run 2 — must APPEND (pre-fix this collided on the unique index and dropped the recommendation).
    const run2 = await newRun();
    const rec2 = await rec.runForZone(zoneId, { now: NOW, runId: run2 });
    const out2 = await dispatch.dispatchForZone(zoneId, { dateFrom: DAY, dateTo: DAY, now: NOW, runId: run2 });

    // Reconciliation guarantee the ledger sums over: recommended === dispatched (no phantom drop).
    expect(rec2.recommended).toBe(1);
    expect(out2.tickets).toBe(1);
    expect(out2.skipReason).toBeUndefined(); // no SCHEDULE_CONFLICT skip

    // Still exactly ONE active schedule for the SE — the new work appended, no second day-plan.
    const scheduleAfter2 = await prisma.workSchedule.findMany({ where: { zoneId, seId, status: 'ACTIVE' } });
    expect(scheduleAfter2).toHaveLength(1);
    expect(scheduleAfter2[0].scheduleId).toBe(scheduleId);

    // The appended batch is a FRESH stop stamped with run 2 (clean run-attribution for the ledger).
    const appended = await prisma.plantBatchAssignment.findMany({ where: { scheduleId, runId: run2 } });
    expect(appended).toHaveLength(1);
    expect(appended[0].stopSequence).toBe(2); // continues after run 1's stop 1, never reorders it

    // All three tickets are FORMALLY_ASSIGNED, each with exactly one LIVE assignment (no duplication).
    const tix = await prisma.ticket.findMany({ where: { ticketId: { in: ticketIds } } });
    expect(tix.every((t) => t.assignmentState === 'FORMALLY_ASSIGNED')).toBe(true);
    const live = await activeAssignmentsFor(ticketIds);
    expect(live).toHaveLength(3);
    expect(new Set(live.map((a) => a.ticketId)).size).toBe(3);
    expect(live.some((a) => a.ticketId === newTicket)).toBe(true);
  });

  it('a duplicate SUGGESTED rec for an already-assigned ticket is skipped, not double-dispatched', async () => {
    // Fabricate a raced/retried state: a live SUGGESTED rec pointing at a ticket that already sits in a
    // LIVE batch (the recommender would never do this — it only picks UNASSIGNED — so we craft it).
    const assignedTicket = ticketIds[0];
    const before = await activeAssignmentsFor([assignedTicket]);
    expect(before).toHaveLength(1);

    const run3 = await newRun();
    await prisma.recommendation.create({
      data: { ticketId: assignedTicket, seId, status: 'SUGGESTED', path: 'MORNING_BATCH', scoreBreakdown: {}, runId: run3 },
    });

    const out3 = await dispatch.dispatchForZone(zoneId, { dateFrom: DAY, dateTo: DAY, now: NOW, runId: run3 });
    expect(out3.tickets).toBe(0); // idempotency guard dropped it — no second assignment

    // Still exactly one LIVE assignment for that ticket; the guard rec was consumed, not re-loopable.
    const after = await activeAssignmentsFor([assignedTicket]);
    expect(after).toHaveLength(1);
    const guardRec = await prisma.recommendation.findFirst({ where: { ticketId: assignedTicket, runId: run3 } });
    expect(guardRec?.status).toBe('DISPATCHED');
  });

  it('#153 — appends onto an OVERRIDDEN schedule too, instead of creating a colliding second day-plan', async () => {
    // A ZM adjusts the morning plan. Any override flips the SCHEDULE to OVERRIDDEN, and the APPEND
    // lookup used to require status ACTIVE — so it found nothing and created a SECOND schedule for the
    // same (se, zone, day). The unique index does NOT catch that: it is partial on `status = 'ACTIVE'`
    // (migration 20260708120000), so an OVERRIDDEN row is invisible to it. That silently re-opened the
    // duplicate-day-plan class #126/#127 closed — for every SE whose ZM had touched their plan.
    const stop1 = await prisma.plantBatchAssignment.findFirstOrThrow({
      where: { schedule: { zoneId, seId } },
      orderBy: { stopSequence: 'asc' },
    });
    await override.override(
      stop1.batchId,
      { action: 'REORDER', stopSequence: 1, reasonCode: 'ROUTE_OPT' },
      { role: 'ZONAL_MANAGER', zoneId: Number(zoneId) },
      { userId: '11111111-1111-1111-1111-111111111111', role: 'ZONAL_MANAGER', actedAsRole: null },
    );
    overriddenBatchIds.push(stop1.batchId);

    const schedulesBefore = await prisma.workSchedule.findMany({ where: { zoneId, seId } });
    expect(schedulesBefore).toHaveLength(1);
    expect(schedulesBefore[0].status).toBe('OVERRIDDEN'); // the mechanism under test, asserted not assumed
    const scheduleId = schedulesBefore[0].scheduleId;

    // Fresh backlog arrives after the ZM's adjustment — the same "same-day re-run" case as above.
    const lateTicket = await makeTicket(30);
    const run4 = await newRun();
    const rec4 = await rec.runForZone(zoneId, { now: NOW, runId: run4 });
    const out4 = await dispatch.dispatchForZone(zoneId, { dateFrom: DAY, dateTo: DAY, now: NOW, runId: run4 });
    expect(rec4.recommended).toBe(1);
    expect(out4.tickets).toBe(1);
    expect(out4.skipReason).toBeUndefined();

    // Still exactly ONE schedule for (se, zone, day) — the new stop appended onto the overridden plan.
    const schedulesAfter = await prisma.workSchedule.findMany({ where: { zoneId, seId } });
    expect(schedulesAfter).toHaveLength(1);
    expect(schedulesAfter[0].scheduleId).toBe(scheduleId);

    const appended = await prisma.plantBatchAssignment.findMany({ where: { scheduleId, runId: run4 } });
    expect(appended).toHaveLength(1);
    const live = await activeAssignmentsFor([lateTicket]);
    expect(live).toHaveLength(1);
    expect(live[0].batchId).toBe(appended[0].batchId);
  });
});
