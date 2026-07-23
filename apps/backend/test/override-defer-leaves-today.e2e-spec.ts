import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { DayPlanQueryService } from '../src/scheduling/day-plan-query.service';
import { LoggingDayPlanNotifier } from '../src/scheduling/day-plan-notifier';
import { DispatchTransparencyQueryService } from '../src/scheduling/dispatch-transparency-query.service';
import { OverrideService } from '../src/scheduling/override.service';
import { ZmScheduleQueryService } from '../src/scheduling/zm-schedule-query.service';

/**
 * #146 B1 slice 1 — `DEFER_TICKET` must actually remove the ticket from TODAY's plan.
 *
 * `docs/workflow/fsm-business-technical-workflow.md:711` defines defer in two clauses, both mandatory:
 *
 *   | **Defer Ticket** | Ticket pushed to a specific future date; removed from current batch |
 *
 * Today only the audit row and `deferred_to_date` are written. `deferredToDate` has a writer and
 * **zero readers** across `apps/backend/src`, so the ZM gets 200 OK, an audit entry and an OVERRIDDEN
 * badge — and the ticket stays on the SE's plan for the rest of the day.
 *
 * Slice 1 gives defer the "removed from current batch" clause only: stamp `removedAt` alongside
 * `deferredToDate`. Every read already filters `removedAt: null`, so all three surfaces below fall
 * into line at once, and capacity frees itself (slice 2 asserts that).
 *
 * Slice 1 deliberately did NOT touch `assignmentState`: flipping the ticket to `UNASSIGNED` before a
 * date gate existed would have made it immediately re-dispatchable *today* — the recommender selects
 * `OPEN` + `UNASSIGNED` (`recommender.service.ts:103-108`) — which is worse than the bug being fixed.
 * **Slice 3 has since landed** and added the `deferred_until` column plus the shared `notDeferredOn`
 * predicate, so the ticket is now `UNASSIGNED` *and* dated. The last test here tracks that; the rest
 * of the file is unchanged, which is the point — slice 3 altered how defer is enforced, not what
 * these three read surfaces show.
 *
 * Both tickets sit on the SAME plant, so they share one batch: the sibling assertion proves the defer
 * removed one ticket rather than emptying the stop.
 */
const NS = Date.now();

describe('#146 slice 1 — a deferred ticket leaves today\'s reads, its batch-mate does not', () => {
  let prisma: PrismaService;
  let rec: RecommenderService;
  let dispatch: BatchAssignmentService;
  let override: OverrideService;
  let dayPlan: DayPlanQueryService;
  let zmQuery: ZmScheduleQueryService;
  let transparency: DispatchTransparencyQueryService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let se: string;
  let batchId: bigint;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  let deferred: string;
  let sibling: string;

  const ZM = { userId: '11111111-1111-1111-1111-111111111111', role: 'ZONAL_MANAGER', actedAsRole: null };
  const NOW = new Date('2026-06-24T06:00:00Z');
  const DAY = new Date(Date.UTC(2026, 5, 24));
  let scope: { role: string; zoneId: number };

  const makeTicket = async (gpsAgeMin: number): Promise<string> => {
    const deviceId = String(10_460_000_000 + (NS % 100_000) * 10 + deviceIds.length);
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

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    rec = new RecommenderService(prisma, new CandidateSelectionService(prisma));
    dispatch = new BatchAssignmentService(prisma);
    override = new OverrideService(prisma, new AuditService(prisma), new LoggingDayPlanNotifier());
    dayPlan = new DayPlanQueryService(prisma);
    zmQuery = new ZmScheduleQueryService(prisma);
    transparency = new DispatchTransparencyQueryService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-dlt-' + NS } })).zoneId;
    scope = { role: 'ZONAL_MANAGER', zoneId: Number(zoneId) };
    companyId = (
      await prisma.company.create({ data: { name: 'Co-dlt-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-dlt-' + NS, zoneId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@dlt.test`, zoneId },
    });
    userIds.push(u.userId);
    se = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
    await prisma.seCoverage.create({ data: { seId: se, plantId, coverageType: 'DEDICATED' } });

    deferred = await makeTicket(180); // older → sortOrder 1
    sibling = await makeTicket(60);

    await rec.runForZone(zoneId, { now: NOW });
    await dispatch.dispatchForZone(zoneId, { dateFrom: DAY, dateTo: DAY, now: NOW });

    batchId = (await prisma.plantBatchAssignment.findFirstOrThrow({ where: { plantId } })).batchId;
  });

  afterAll(async () => {
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

  const planTickets = async () => {
    const plan = await dayPlan.getDayPlan(se);
    return plan.stops.flatMap((s) => s.tickets.map((t) => t.ticketId));
  };

  it('control — both tickets share one stop before the defer', async () => {
    const onPlan = await planTickets();
    expect(onPlan).toHaveLength(2);
    expect(onPlan).toContain(deferred);
    expect(onPlan).toContain(sibling);
  });

  it('the deferred ticket leaves the SE day plan; its batch-mate stays', async () => {
    const out = await override.override(
      batchId,
      { action: 'DEFER_TICKET', ticketId: deferred, deferredToDate: '2026-06-28', reasonCode: 'PARTS_ETA' },
      scope,
      ZM,
    );
    expect(out.result).toBe('OK');

    const onPlan = await planTickets();
    expect(onPlan).not.toContain(deferred);
    expect(onPlan).toContain(sibling); // the stop lost one ticket, it was not emptied
  });

  it('the deferred ticket leaves the ZM schedule view', async () => {
    const detail = await zmQuery.getScheduleDetail(se, scope);
    const onView = detail?.stops.flatMap((s) => s.tickets.map((t) => t.ticketId)) ?? [];
    expect(onView).not.toContain(deferred);
    expect(onView).toContain(sibling);
  });

  it('the deferred ticket leaves the dispatch-transparency batch read', async () => {
    const batch = await transparency.getBatchDetail(batchId, scope);
    const onBatch = batch?.rows.map((r) => r.ticketId) ?? [];
    expect(onBatch).not.toContain(deferred);
    expect(onBatch).toContain(sibling);
  });

  it('the deferred-to date is still recorded, and the ZM scorecard can still count the deferral', async () => {
    // AC#7 — `zm_performance_summary_monthly.deferrals` is a graded ZM metric (CONTEXT.md:521), so the
    // defer must stay *countable* after it stops being *visible*. Removal is what changes; the date and
    // the audit trail are what the scorecard reads.
    const row = await prisma.batchAssignmentTicket.findFirstOrThrow({ where: { batchId, ticketId: deferred } });
    expect(row.deferredToDate?.toISOString().slice(0, 10)).toBe('2026-06-28');
    expect(row.removedAt).not.toBeNull();

    const audits = await prisma.auditLog.findMany({
      where: { entityType: 'plant_batch_assignment', entityId: String(batchId) },
    });
    expect(audits.some((a) => JSON.stringify(a.metadata).includes('DEFER_TICKET'))).toBe(true);
  });

  it('the ticket is returned to the pool but held by its deferral date, not re-dispatchable today', async () => {
    // This assertion was inverted by slice 3, deliberately and as documented. Slices 1-2 pinned
    // `FORMALLY_ASSIGNED` because, without a date gate, `UNASSIGNED` meant "re-dispatch me today" —
    // the hazard the handoff called out. Slice 3 added `deferred_until` + the shared `notDeferredOn`
    // predicate, so the correct state is now UNASSIGNED (re-plannable) AND dated (not yet).
    // The pair is what makes it safe; neither half is correct alone.
    const t = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: deferred } });
    expect(t.assignmentState).toBe('UNASSIGNED');
    expect(t.deferredUntil?.toISOString().slice(0, 10)).toBe('2026-06-28');
  });
});
