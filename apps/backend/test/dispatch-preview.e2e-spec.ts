import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { DispatchRunService } from '../src/scheduling/dispatch-run.service';

/**
 * #250 — preview orchestration, and the footgun it closes.
 *
 * `runForActiveZones` builds `work_schedules` dated `istDate(now)`. Nothing ever validated that
 * argument: passing it a future date would have created **real** future-dated day plans, dispatched
 * to real SEs, indistinguishable from ones the 05:00 cron built. The only thing preventing it was
 * that both live callers hardcode `new Date()` — an accident of the call sites, not a property of the
 * function. Now that a preview needs to ask about tomorrow, that accident stops being load-bearing:
 * the dry-run path becomes the sanctioned way to ask, and the real path refuses.
 *
 * The orchestration assertions are about what preview *does not* do — no ledger row, no in-flight
 * slot, no advisory lock — because those are the properties that let an operator open the page during
 * a live dispatch without consequence.
 */
const NS = Date.now();
const NOW = new Date('2026-06-21T06:00:00Z');
const TOMORROW = new Date('2026-06-22T06:00:00Z');
/**
 * A day that is future relative to the **real** wall clock, which is what the guard compares against.
 * The fixture's frozen `NOW`/`TOMORROW` are both historical by the time this suite runs, so they
 * cannot exercise the refusal — using them here would produce a test that passes for the wrong reason.
 */
const REAL_FUTURE = new Date(Date.now() + 2 * 24 * 3_600_000);

describe('#250 — dispatch preview orchestration + the future-date guard', () => {
  let prisma: PrismaService;
  let svc: DispatchRunService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let se: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];

  const countAll = async () => ({
    recommendations: await prisma.recommendation.count(),
    traces: await prisma.dispatchDecisionTrace.count(),
    componentBlocked: await prisma.componentBlockedQueue.count(),
    schedules: await prisma.workSchedule.count(),
    batches: await prisma.plantBatchAssignment.count(),
    batchTickets: await prisma.batchAssignmentTicket.count(),
    runs: await prisma.dispatchRun.count(),
  });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new DispatchRunService(
      prisma,
      new RecommenderService(prisma, new CandidateSelectionService(prisma)),
      new BatchAssignmentService(prisma),
    );

    zoneId = (await prisma.zone.create({ data: { name: 'Z-pv-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-pv-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-pv-' + NS, zoneId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@pv.test`, zoneId },
    });
    userIds.push(u.userId);
    se = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
    await prisma.seCoverage.create({ data: { seId: se, plantId, coverageType: 'DEDICATED' } });

    const deviceId = String(12_500_000_000 + (NS % 100_000));
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
    await prisma.dispatchDecisionTrace.deleteMany({ where: { zoneId } });
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.componentBlockedQueue.deleteMany({ where: { ticketId: { in: ticketIds } } });
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
   * AC-1 (orchestration level) — the whole point: an operator can open tomorrow's preview mid-dispatch
   * and change nothing. No `dispatch_runs` row in particular: the ledger is the record of runs that
   * actually happened, and a preview that appeared there would corrupt every run-history read.
   */
  it('AC-1: previewing a future day writes nothing at all', async () => {
    const before = await countAll();
    const preview = await svc.previewActiveZones(TOMORROW, { zoneId, now: NOW });
    const after = await countAll();

    expect(after).toEqual(before);
    expect(preview.targetDate).toBe('2026-06-22');
    expect(preview.zones).toHaveLength(1);
    expect(preview.zones[0].zoneId).toBe(String(zoneId));
    expect(preview.zones[0].decisions).toHaveLength(1);
    expect(preview.zones[0].decisions[0].seId).toBe(se);
  });

  /**
   * The preview takes no in-flight slot, so it can neither block a real run nor be refused by one. If
   * it took the guard, the real run below would come back CONFLICT instead of RAN.
   *
   * #259 — the slot is now a claim row, so this reads the ledger rather than process memory: a preview
   * that wrote one would be visible to every instance, not just this one.
   */
  it('AC-1: a preview holds no in-flight slot and does not block a real run', async () => {
    await svc.previewActiveZones(TOMORROW, { zoneId, now: NOW });
    expect((await svc.inFlightZones()).filter((f) => f.zoneId === String(zoneId))).toHaveLength(0);

    const outcome = await svc.runForActiveZones(NOW, { zoneId });
    expect(outcome.result).toBe('RAN');
  });

  /**
   * AC-5 — the real path refuses a future day. Guarded rather than merely documented: the argument is
   * injectable, the damage (real future-dated day plans dispatched to real SEs) is silent, and the
   * preview now gives the legitimate use case a home.
   */
  it('AC-5: the real dispatch path refuses a future run date', async () => {
    await expect(svc.runForActiveZones(REAL_FUTURE, { zoneId })).rejects.toThrow(/future/i);
    // And it refuses *before* doing anything — no ledger row for a run that was never allowed.
    const runs = await prisma.dispatchRun.count();
    await expect(svc.runForActiveZones(REAL_FUTURE, { zoneId })).rejects.toThrow();
    expect(await prisma.dispatchRun.count()).toBe(runs);
  });

  /** A past or present run date is not the future — the guard must not break the path it protects. */
  it('AC-5: today is still accepted', async () => {
    const outcome = await svc.runForActiveZones(NOW, { zoneId });
    expect(outcome.result).toBe('RAN');
  });
});
