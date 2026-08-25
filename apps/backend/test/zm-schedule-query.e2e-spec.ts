import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { ZmScheduleQueryService } from '../src/scheduling/zm-schedule-query.service';

/**
 * Issue 13a, slice 1 — ZM monitoring reads (AC#1/#2). listSchedules gives per-SE rows (batch count,
 * date range, AUTO_ASSIGNED/OVERRIDDEN status) zone-scoped for a ZM; getScheduleDetail gives the
 * ordered stops plus the per-ticket "Why suggested?" Recommender reasoning. Monitoring only — no
 * approval/countdown semantics.
 */
const NS = Date.now();

describe('Issue 13a slice 1 — ZmScheduleQueryService', () => {
  let prisma: PrismaService;
  let rec: RecommenderService;
  let dispatch: BatchAssignmentService;
  let zm: ZmScheduleQueryService;

  let zoneId: bigint;
  let otherZoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let se: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  const NOW = new Date('2026-06-21T06:00:00Z');

  const makeTicket = async (plant: bigint, gpsAgeMin: number): Promise<string> => {
    const deviceId = String(10_100_000_000 + (NS % 100_000) * 10 + deviceIds.length);
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
    const ticket = await prisma.ticket.create({
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
    ticketIds.push(ticket.ticketId);
    return ticket.ticketId;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    rec = new RecommenderService(prisma, new CandidateSelectionService(prisma));
    dispatch = new BatchAssignmentService(prisma);
    zm = new ZmScheduleQueryService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-zm-' + NS } })).zoneId;
    otherZoneId = (await prisma.zone.create({ data: { name: 'Z-zm-other-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-zm-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-zm-' + NS, zoneId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@zm.test`, zoneId },
    });
    userIds.push(u.userId);
    se = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
    await prisma.seCoverage.create({ data: { seId: se, plantId, coverageType: 'DEDICATED' } });

    await makeTicket(plantId, 180);
    await makeTicket(plantId, 60);

    // Ungated PARTIAL_RECOVERY state (Issue 79): the older ticket carries a PARTIAL_RECOVERY verification
    // outcome (Issue 18) — the badge source that is *not* the gated "Why suggested?" reasoning.
    await prisma.verificationRun.create({
      data: { ticketId: ticketIds[0], deviceId: deviceIds[0], startedAt: NOW, outcome: 'PARTIAL_RECOVERY' },
    });

    await rec.runForZone(zoneId, { now: NOW });
    await dispatch.dispatchForZone(zoneId, { dateFrom: NOW, dateTo: NOW, now: NOW });
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
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.verificationRun.deleteMany({ where: { ticketId: { in: ticketIds } } });
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

  it('lists per-SE schedule rows for the ZM zone with batch/ticket counts and status', async () => {
    const rows = await zm.listSchedules({ role: 'ZONAL_MANAGER', zoneId: Number(zoneId) });
    const mine = rows.filter((r) => r.seId === se);
    expect(mine).toHaveLength(1);
    expect(mine[0].status).toBe('ACTIVE');
    expect(mine[0].batchCount).toBe(1);
    expect(mine[0].ticketCount).toBe(2);
  });

  /**
   * #284 §D — the date filter the page's own label has always implied.
   *
   * `listSchedules` filters on live status alone and carries **no date predicate**, so it returns a
   * never-closed plan from last week beside today's while the nav row, the page copy and
   * `DispatchTimelineNote` all say "today". The filter is **additive**: no argument keeps the existing
   * all-live answer, because callers depend on it and #284 AC10 says so explicitly.
   */
  it('#284 — no date argument keeps the existing all-live answer', async () => {
    const rows = await zm.listSchedules({ role: 'ZONAL_MANAGER', zoneId: Number(zoneId) });
    expect(rows.some((r) => r.seId === se)).toBe(true);
  });

  it('#284 — ?date= keeps a plan whose range covers that IST day', async () => {
    const rows = await zm.listSchedules({ role: 'ZONAL_MANAGER', zoneId: Number(zoneId) }, { date: NOW });
    expect(rows.some((r) => r.seId === se)).toBe(true);
  });

  it('#284 — ?date= drops a plan whose range does not cover that day, stale-but-live included', async () => {
    const nextWeek = new Date('2026-06-28T06:00:00Z');
    const rows = await zm.listSchedules({ role: 'ZONAL_MANAGER', zoneId: Number(zoneId) }, { date: nextWeek });
    expect(rows.some((r) => r.seId === se)).toBe(false);
  });

  it('excludes schedules from other zones for a zone-scoped ZM', async () => {
    const rows = await zm.listSchedules({ role: 'ZONAL_MANAGER', zoneId: Number(otherZoneId) });
    expect(rows.some((r) => r.seId === se)).toBe(false);
  });

  it('returns ordered stops with per-ticket Recommender reasoning in the detail view', async () => {
    const detail = await zm.getScheduleDetail(se, { role: 'ZONAL_MANAGER', zoneId: Number(zoneId) });
    expect(detail).not.toBeNull();
    expect(detail!.stops).toHaveLength(1);
    const stop = detail!.stops[0];
    expect(stop.deviceCount).toBe(2);
    const reasoning = stop.tickets[0].reasoning;
    expect(reasoning).not.toBeNull();
    expect(reasoning!.companyTier).toBe('GOLD');
    expect(reasoning!.deviceBucket).toBe('CRITICAL');
    expect(reasoning!.companyPriorityRank).toBe('B');
    expect(typeof reasoning!.clusterMultiplier).toBe('number');
  });

  it('carries ungated per-ticket state (slaBucket / companyTier / partialRecovery) on each stop ticket', async () => {
    const detail = await zm.getScheduleDetail(se, { role: 'ZONAL_MANAGER', zoneId: Number(zoneId) });
    expect(detail).not.toBeNull();
    const tickets = detail!.stops[0].tickets;

    // Ungated state — sourced independently of the gated "Why suggested?" reasoning: slaBucket from the
    // live device_states, companyTier denormalised on the ticket, partialRecovery from a PARTIAL_RECOVERY
    // verification outcome. These feed the reference-12 per-ticket PARTIAL/CRITICAL/tier card badges.
    const older = tickets.find((t) => t.ticketId === ticketIds[0]);
    expect(older).toBeDefined();
    expect(older!.slaBucket).toBe('CRITICAL');
    expect(older!.companyTier).toBe('GOLD');
    expect(older!.partialRecovery).toBe(true);

    const other = tickets.find((t) => t.ticketId === ticketIds[1]);
    expect(other).toBeDefined();
    expect(other!.partialRecovery).toBe(false);
  });

  // #179 slice 3 — same hollow-stop defect as the SE day plan, on the ZM's view of the same schedule.
  it('filters out a stop whose every ticket has been removed, keeping a partially-live stop', async () => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@zm-hollow.test`, zoneId },
    });
    const hollowSe = u.userId;
    const plantLiveId = (await prisma.plant.create({ data: { name: 'P-zm-live-' + NS, zoneId } })).plantId;
    const plantHollowId = (await prisma.plant.create({ data: { name: 'P-zm-hollow-' + NS, zoneId } })).plantId;
    await prisma.engineerMaster.create({ data: { engineerId: hollowSe, coverageType: 'MULTI_PLANT', zoneId, dailyCapacity: 10 } });
    await prisma.seCoverage.create({ data: { seId: hollowSe, plantId: plantLiveId, coverageType: 'MULTI_PLANT' } });
    await prisma.seCoverage.create({ data: { seId: hollowSe, plantId: plantHollowId, coverageType: 'MULTI_PLANT' } });

    const liveTicket = await makeTicket(plantLiveId, 150);
    const hollowTicket = await makeTicket(plantHollowId, 90);

    try {
      await rec.runForZone(zoneId, { now: NOW });
      await dispatch.dispatchForZone(zoneId, { dateFrom: NOW, dateTo: NOW, now: NOW });

      await prisma.batchAssignmentTicket.updateMany({
        where: { ticketId: hollowTicket },
        data: { removedAt: NOW, removedBy: hollowSe },
      });

      const detail = await zm.getScheduleDetail(hollowSe, { role: 'ZONAL_MANAGER', zoneId: Number(zoneId) });
      expect(detail).not.toBeNull();
      expect(detail!.stops).toHaveLength(1);
      expect(detail!.stops[0].plantId).toBe(String(plantLiveId));
      expect(detail!.stops[0].tickets.map((t) => t.ticketId)).toEqual([liveTicket]);
    } finally {
      const schedules = await prisma.workSchedule.findMany({ where: { zoneId, seId: hollowSe }, select: { scheduleId: true } });
      const batches = await prisma.plantBatchAssignment.findMany({ where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } }, select: { batchId: true } });
      await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
      await prisma.plantBatchAssignment.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
      await prisma.workSchedule.deleteMany({ where: { zoneId, seId: hollowSe } });
      await prisma.recommendation.deleteMany({ where: { ticketId: { in: [liveTicket, hollowTicket] } } });
      await prisma.dispatchDecisionTrace.deleteMany({ where: { ticketId: { in: [liveTicket, hollowTicket] } } });
      await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: [liveTicket, hollowTicket] } } });
      await prisma.ticket.deleteMany({ where: { ticketId: { in: [liveTicket, hollowTicket] } } });
      await prisma.seCoverage.deleteMany({ where: { plantId: { in: [plantLiveId, plantHollowId] } } });
      await prisma.engineerMaster.deleteMany({ where: { engineerId: hollowSe } });
      await prisma.user.deleteMany({ where: { userId: hollowSe } });
      await prisma.plant.deleteMany({ where: { plantId: { in: [plantLiveId, plantHollowId] } } });
    }
  });
});
