import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { LoggingDayPlanNotifier } from '../src/scheduling/day-plan-notifier';
import { OverrideService } from '../src/scheduling/override.service';

/**
 * #146 B1 slice 2 (AC#2, AC#4) — a deferred ticket must stop burning the SE's capacity for a day it
 * will not be worked, and non-deferred work must be completely unaffected.
 *
 * `committedDayLoad` counts `batch_assignment_tickets WHERE removed_at IS NULL`
 * (`recommender.service.ts:548-555`), so slice 1's `removedAt` stamp frees the slot for free. This
 * spec is still the AC: it asserts the freeing at the **recommender seam** (`runForZone` → the
 * recommendation the SE does or does not get), not by re-reading the count query.
 *
 * The zero-deferred-rows regression is the important half. It pins that capacity accounting is
 * unchanged when nothing is deferred — if defer semantics ever start leaking into the general
 * capacity path, this test goes red before any real plan is mis-sized.
 */
const NS = Date.now();

describe('#146 slice 2 — defer frees the SE slot; zero-deferred capacity is unchanged', () => {
  let prisma: PrismaService;
  let rec: RecommenderService;
  let dispatch: BatchAssignmentService;
  let override: OverrideService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let se: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  let committed: string;
  let batchId: bigint;

  const ZM = { userId: '11111111-1111-1111-1111-111111111111', role: 'ZONAL_MANAGER', actedAsRole: null };
  const NOW = new Date('2026-06-25T06:00:00Z');
  const DAY = new Date(Date.UTC(2026, 5, 25));
  let scope: { role: string; zoneId: number };

  const makeTicket = async (gpsAgeMin: number): Promise<string> => {
    const deviceId = String(10_620_000_000 + (NS % 100_000) * 10 + deviceIds.length);
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

  const recFor = (ticketId: string) =>
    prisma.recommendation.findFirst({ where: { ticketId }, orderBy: { recommendationId: 'desc' } });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    rec = new RecommenderService(prisma, new CandidateSelectionService(prisma));
    dispatch = new BatchAssignmentService(prisma);
    override = new OverrideService(prisma, new AuditService(prisma), new LoggingDayPlanNotifier());

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

    zoneId = (await prisma.zone.create({ data: { name: 'Z-dfc-' + NS } })).zoneId;
    scope = { role: 'ZONAL_MANAGER', zoneId: Number(zoneId) };
    companyId = (
      await prisma.company.create({ data: { name: 'Co-dfc-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-dfc-' + NS, zoneId } })).plantId;

    // Capacity 1 — one committed ticket is a full day, which makes the freed slot observable.
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@dfc.test`, zoneId },
    });
    userIds.push(u.userId);
    se = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 1 } });
    await prisma.seCoverage.create({ data: { seId: se, plantId, coverageType: 'DEDICATED' } });

    committed = await makeTicket(180);
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

  it('AC#4 regression — with ZERO deferred rows, a committed ticket still consumes the slot', async () => {
    // Written first and passes immediately: this is the "capacity is byte-identical when nothing is
    // deferred" pin. If it ever fails, the harness is wrong and no defer conclusion below is valid.
    const blocked = await makeTicket(90);
    await rec.runForZone(zoneId, { now: NOW });

    const r = await recFor(blocked);
    expect(r?.seId).toBeNull();
    expect(r?.status).toBe('UNASSIGNABLE'); // SE is 1/1 from the committed ticket
  });

  it('AC#2 — deferring the committed ticket frees the slot for the same day', async () => {
    const out = await override.override(
      batchId,
      { action: 'DEFER_TICKET', ticketId: committed, deferredToDate: '2026-06-29', reasonCode: 'PARTS_ETA' },
      scope,
      ZM,
    );
    expect(out.result).toBe('OK');

    await rec.runForZone(zoneId, { now: NOW });

    // The still-open second ticket can now be planned: the deferred one no longer occupies the day.
    const r = await recFor(ticketIds[1]);
    expect(r?.seId).toBe(se);
    expect(r?.status).toBe('SUGGESTED');
  });

  it('the deferred ticket itself is not re-planned today (slice-1 boundary still holds)', async () => {
    // It is still FORMALLY_ASSIGNED, so the recommender cannot pick it up. Freeing the SLOT and
    // re-planning the TICKET are different things; the second waits for slice 3's `deferred_until`.
    const r = await recFor(committed);
    expect(r?.status).not.toBe('SUGGESTED');
    const t = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: committed } });
    expect(t.assignmentState).toBe('FORMALLY_ASSIGNED');
  });
});
