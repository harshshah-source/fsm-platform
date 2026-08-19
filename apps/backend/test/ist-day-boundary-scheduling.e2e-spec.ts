import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { LoggingDayPlanNotifier } from '../src/scheduling/day-plan-notifier';
import { OverrideService } from '../src/scheduling/override.service';

/**
 * #240 — IST day-boundary correctness for the two scheduling paths that still derived their day from
 * **UTC** components (`recommender.service.ts:590` `plannerForDate`, `override.service.ts:282`
 * `assignTicket`) after #204/#198 made `Asia/Kolkata` the operating day (CONTEXT.md Decisions §19).
 *
 * The defect only exists in one window and is invisible outside it: IST is UTC+05:30, so between
 * **00:00 and 05:29 IST** the UTC calendar date is still *yesterday*. Both paths therefore acted on
 * the previous IST day — the planner read yesterday's `se_planner` rows (silently losing the soft
 * bias), and a manual assign landed on a schedule dated yesterday, a *different* day from the one the
 * 05:00 dispatch builds for the same instant.
 *
 * Every instant below is inside that window: `2026-06-21T19:30:00Z` is **01:00 IST on 2026-06-22**.
 * The assertions are what the IST day says, so they fail on UTC-derived code and pass on `istDate`.
 */
const NS = Date.now();

/** 01:00 IST on 2026-06-22 — inside the 00:00–05:29 IST window where UTC still reads 2026-06-21. */
const NOW = new Date('2026-06-21T19:30:00Z');
/** The IST calendar day of {@link NOW}, as `@db.Date` values carry it (UTC midnight of that date). */
const IST_DAY = new Date('2026-06-22T00:00:00Z');
/** What the UTC-derived code used instead — the day before. */
const UTC_DAY = new Date('2026-06-21T00:00:00Z');

describe('#240 — IST day boundary: planner bias and manual assign', () => {
  let prisma: PrismaService;
  let rec: RecommenderService;
  let override: OverrideService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let dedicatedSe: string; // precedence-first candidate
  let plannedSe: string; // named by the planner for the IST day
  let assignSe: string; // target of the manual assign
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  let biasTicket: string;
  let assignTicketId: string;
  let scope: { role: string; zoneId: number };
  const ZM = { userId: '11111111-1111-1111-1111-111111111111', role: 'ZONAL_MANAGER', actedAsRole: null };

  const makeSe = async (coverage: 'DEDICATED' | 'MULTI_PLANT'): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@ist240.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({ data: { engineerId: u.userId, coverageType: coverage, zoneId, dailyCapacity: 10 } });
    return u.userId;
  };

  const makeTicket = async (): Promise<string> => {
    const deviceId = String(10_900_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        hasOpenFailureCycle: true,
        latestGpsDatetime: new Date(NOW.getTime() - 120 * 60_000),
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
    override = new OverrideService(prisma, new AuditService(prisma), new LoggingDayPlanNotifier());

    zoneId = (await prisma.zone.create({ data: { name: 'Z-ist240-' + NS } })).zoneId;
    scope = { role: 'ZONAL_MANAGER', zoneId: Number(zoneId) };
    companyId = (
      await prisma.company.create({ data: { name: 'Co-ist240-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-ist240-' + NS, zoneId } })).plantId;

    dedicatedSe = await makeSe('DEDICATED');
    plannedSe = await makeSe('MULTI_PLANT');
    assignSe = await makeSe('DEDICATED');
    await prisma.seCoverage.create({ data: { seId: dedicatedSe, plantId, coverageType: 'DEDICATED' } });
    await prisma.seCoverage.create({ data: { seId: plannedSe, plantId, coverageType: 'MULTI_PLANT' } });

    // The planner names `plannedSe` for the plant on the **IST** day of NOW. A UTC-derived lookup
    // asks for 2026-06-21 instead and finds nothing, so the bias silently vanishes.
    await prisma.sePlanner.create({ data: { seId: plannedSe, plantId, plannedDate: IST_DAY } });

    biasTicket = await makeTicket();
    assignTicketId = await makeTicket();

    await rec.runForZone(zoneId, { now: NOW });
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
    await prisma.sePlanner.deleteMany({ where: { seId: { in: userIds } } });
    await prisma.auditLog.deleteMany({ where: { entityType: 'ticket', entityId: { in: ticketIds } } });
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
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  /**
   * AC-2 — the planner bias (ADR-0022) is keyed on the run date, so reading the wrong day drops it
   * entirely and selection falls back to strict precedence with nothing logged. Observed through the
   * recommendation the run wrote, not by reaching at the private lookup.
   */
  it('AC-2: reads se_planner rows for the IST day of `now`, not the UTC day', async () => {
    const r = await prisma.recommendation.findFirstOrThrow({
      where: { ticketId: biasTicket },
      orderBy: { recommendationId: 'desc' },
    });
    expect(r.seId).toBe(plannedSe); // UTC-derived: finds no planner row → falls back to dedicatedSe
  });

  /**
   * AC-3 — `assignTicket` finds-or-creates the SE's `work_schedules` row for the day, and
   * `date_from`/`date_to` are `@db.Date`. Deriving that day from UTC put a 01:00 IST manual assign on
   * a schedule dated *yesterday* — a different row from the one the 05:00 dispatch builds and the one
   * the Day Plan reads for the same instant, so the ticket was assigned onto a plan nobody serves.
   */
  it('AC-3: creates the manual-assign schedule on the IST day of `now`, not the UTC day', async () => {
    const outcome = await override.assignTicket(assignTicketId, assignSe, scope, ZM, NOW);
    expect(outcome.result).toBe('OK');

    const schedule = await prisma.workSchedule.findFirstOrThrow({ where: { zoneId, seId: assignSe } });
    expect(schedule.dateFrom.toISOString()).toBe(IST_DAY.toISOString());
    expect(schedule.dateTo.toISOString()).toBe(IST_DAY.toISOString());
    expect(schedule.dateFrom.toISOString()).not.toBe(UTC_DAY.toISOString());
  });
});
