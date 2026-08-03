import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { LoggingDayPlanNotifier } from '../src/scheduling/day-plan-notifier';
import { OverrideService } from '../src/scheduling/override.service';
import { SeCoverageService } from '../src/shared-pool/se-coverage.service';
import { SharedPoolService } from '../src/shared-pool/shared-pool.service';

/**
 * #146 B1 slice 3 (AC#3) — the decisive one: a deferred ticket must come back **on its deferred
 * date**, not never.
 *
 * Slices 1–2 gave defer its "removed from current batch" clause, so the ticket leaves today's plan
 * and frees its capacity slot. But `deferTicket` still left `assignmentState` at `FORMALLY_ASSIGNED`,
 * and the recommender selects `OPEN` + `UNASSIGNED` (`recommender.service.ts:103-108`) — so the
 * ticket could **never** be picked up again. It was stranded permanently: off every plan, invisible
 * to every queue, and owned by nobody.
 *
 * The fix is a pair that must land together, never separately:
 *   - defer flips the ticket to `UNASSIGNED` and stamps a ticket-level `deferred_until`;
 *   - every "unassigned work" reader gains `deferred_until IS NULL OR deferred_until <= today`.
 *
 * Flipping the state without the predicate would make the deferred ticket re-dispatchable the *same
 * day* — the exact opposite of a deferral, and worse than the stranding bug. That hazard is why
 * slices 1–2 deliberately left the state alone, and it is what the "today" assertions below guard.
 *
 * The `deferred_until` window is asserted from both sides: closed today, open tomorrow.
 */
const NS = Date.now();

describe('#146 slice 3 — a deferred ticket is re-dispatched ON its deferred date, not never', () => {
  let prisma: PrismaService;
  let rec: RecommenderService;
  let dispatch: BatchAssignmentService;
  let override: OverrideService;
  let pool: SharedPoolService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let se: string;
  let batchId: bigint;
  let ticketId: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];

  const ZM = { userId: '11111111-1111-1111-1111-111111111111', role: 'ZONAL_MANAGER', actedAsRole: null };
  const TODAY_AT = new Date('2026-06-26T06:00:00Z');
  const TODAY = new Date(Date.UTC(2026, 5, 26));
  const TOMORROW_AT = new Date('2026-06-27T06:00:00Z');
  const TOMORROW = new Date(Date.UTC(2026, 5, 27));
  const DEFER_TO = '2026-06-27';
  let scope: { role: string; zoneId: number };

  const liveAssignments = (t: string) =>
    prisma.batchAssignmentTicket.findMany({ where: { ticketId: t, removedAt: null } });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    rec = new RecommenderService(prisma, new CandidateSelectionService(prisma));
    dispatch = new BatchAssignmentService(prisma);
    override = new OverrideService(prisma, new AuditService(prisma), new LoggingDayPlanNotifier());
    pool = new SharedPoolService(prisma, new SeCoverageService(prisma));

    for (const [component, weight] of [
      ['company_priority_rank', 0.4],
      ['dispatch_urgency', 0.3],
      ['repeat_failure_penalty', 0.2],
      ['distance', 0.1],
    ] as const) {
      await prisma.priorityRuleConfig.upsert({
        where: { weightSetRef_component: { weightSetRef: 'v1', component } },
        create: { weightSetRef: 'v1', component, weight, active: true },
        update: { weight, active: true },
      });
    }

    zoneId = (await prisma.zone.create({ data: { name: 'Z-ddl-' + NS } })).zoneId;
    scope = { role: 'ZONAL_MANAGER', zoneId: Number(zoneId) };
    companyId = (
      await prisma.company.create({ data: { name: 'Co-ddl-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-ddl-' + NS, zoneId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@ddl.test`, zoneId },
    });
    userIds.push(u.userId);
    se = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
    await prisma.seCoverage.create({ data: { seId: se, plantId, coverageType: 'DEDICATED' } });

    const deviceId = String(10_700_000_000 + (NS % 100_000) * 10);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        hasOpenFailureCycle: true,
        latestGpsDatetime: new Date(TODAY_AT.getTime() - 180 * 60_000),
        plantId,
        companyId,
        computedAt: TODAY_AT,
      },
    });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: TODAY_AT } });
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        failureCycleId: cycle.cycleId,
        deviceId,
        plantId,
        companyId,
        companyTier: 'GOLD',
        lastStateChangedAt: TODAY_AT,
      },
    });
    ticketId = ticket.ticketId;
    ticketIds.push(ticketId);

    // Today's morning plan: the ticket is dispatched to the SE.
    await rec.runForZone(zoneId, { now: TODAY_AT });
    await dispatch.dispatchForZone(zoneId, { dateFrom: TODAY, dateTo: TODAY, now: TODAY_AT });
    batchId = (await prisma.plantBatchAssignment.findFirstOrThrow({ where: { plantId } })).batchId;

    // The ZM defers it to tomorrow.
    await override.override(
      batchId,
      { action: 'DEFER_TICKET', ticketId, deferredToDate: DEFER_TO, reasonCode: 'PARTS_ETA' },
      scope,
      ZM,
    );
  });

  afterAll(async () => {
    await prisma.dispatchDecisionTrace.deleteMany({ where: { ticketId: { in: ticketIds } } });
    const schedules = await prisma.workSchedule.findMany({ where: { zoneId }, select: { scheduleId: true } });
    const batches = await prisma.plantBatchAssignment.findMany({
      where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } },
      select: { batchId: true },
    });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.workSchedule.deleteMany({ where: { zoneId } });
    await prisma.auditLog.deleteMany({ where: { entityType: 'plant_batch_assignment', entityId: String(batchId) } });
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seCoverage.deleteMany({ where: { seId: se } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('the defer is recorded as a dated deferral, not just a removal', async () => {
    const t = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    // The ticket must be back in the pool of re-plannable work — otherwise nothing can ever pick it up.
    expect(t.assignmentState).toBe('UNASSIGNED');
    // ...and carry the date that holds it back until then. Without this the flip above is a same-day
    // re-dispatch, which is why the two must land together.
    expect(t.deferredUntil?.toISOString().slice(0, 10)).toBe(DEFER_TO);
  });

  it('TODAY — a further dispatch run does NOT put the deferred ticket back on a plan', async () => {
    await rec.runForZone(zoneId, { now: TODAY_AT });
    await dispatch.dispatchForZone(zoneId, { dateFrom: TODAY, dateTo: TODAY, now: TODAY_AT });

    expect(await liveAssignments(ticketId)).toHaveLength(0);
    const r = await prisma.recommendation.findFirst({
      where: { ticketId },
      orderBy: { recommendationId: 'desc' },
    });
    expect(r?.status).not.toBe('SUGGESTED');
  });

  it('TODAY — the deferred ticket is not offered in the SE Shared Pool either', async () => {
    // The defer returns the ticket to `UNASSIGNED`, which is exactly what makes the Shared Pool show
    // it. Deferring work must not hand it straight back to the same SE as pickable secondary work.
    const tickets = await pool.getSharedPool(se, TODAY_AT);
    expect(tickets.map((t) => t.ticketId)).not.toContain(ticketId);
  });

  it('TOMORROW — the deferred ticket is dispatched again on its deferred date', async () => {
    await rec.runForZone(zoneId, { now: TOMORROW_AT });
    const out = await dispatch.dispatchForZone(zoneId, {
      dateFrom: TOMORROW,
      dateTo: TOMORROW,
      now: TOMORROW_AT,
    });

    expect(out.tickets).toBe(1);
    const live = await liveAssignments(ticketId);
    expect(live).toHaveLength(1);

    const t = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    expect(t.assignmentState).toBe('FORMALLY_ASSIGNED');
  });

  it('TOMORROW — the deferral stays countable for the ZM scorecard after re-dispatch', async () => {
    // AC#7 — `zm_performance_summary_monthly.deferrals` reads the audit trail; re-dispatch must not
    // erase the evidence that a deferral happened.
    const audits = await prisma.auditLog.findMany({
      where: { entityType: 'plant_batch_assignment', entityId: String(batchId) },
    });
    expect(audits.some((a) => JSON.stringify(a.metadata).includes('DEFER_TICKET'))).toBe(true);
    const deferredRow = await prisma.batchAssignmentTicket.findFirstOrThrow({
      where: { batchId, ticketId, removedAt: { not: null } },
    });
    expect(deferredRow.deferredToDate?.toISOString().slice(0, 10)).toBe(DEFER_TO);
  });
});
