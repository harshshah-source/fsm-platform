import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';

/**
 * #286 AC8 — a dead run's reasoning outlives the run that replaces it.
 *
 * `clearFinalizedOrphans` (#126) deletes a zone's leftover SUGGESTED recommendations before the next
 * run re-suggests, and `dispatch_decision_traces` **cascades** on that delete (`schema.prisma`
 * `onDelete: Cascade`). So the first thing that happened after a crash was that the next run for the
 * zone destroyed the only record of what the crashed run had intended — the question an operator asks
 * first ("what was it about to do?") had already been answered by deletion.
 *
 * The clearing itself is not the problem and is not being removed: nothing may be double-dispatched,
 * and what guarantees that is `recommendations_one_suggested_per_ticket` plus the in-transaction
 * re-read, not the DELETE. Retiring the row frees the partial unique exactly as deleting it did — the
 * index is `WHERE status = 'SUGGESTED'` — while leaving the evidence where it was.
 */
const NS = Date.now();

describe("#286 — an aborted run's evidence survives the run that replaces it (e2e)", () => {
  let prisma: PrismaService;
  let rec: RecommenderService;

  const NOW = new Date('2026-06-22T06:00:00Z');

  const zoneIds: bigint[] = [];
  const companyIds: bigint[] = [];
  const plantIds: bigint[] = [];
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  const runIds: bigint[] = [];

  const seedZone = async (label: string): Promise<{ zoneId: bigint; seId: string; ticketId: string }> => {
    const zoneId = (await prisma.zone.create({ data: { name: `Z-${label}-${NS}` } })).zoneId;
    zoneIds.push(zoneId);
    const companyId = (
      await prisma.company.create({ data: { name: `Co-${label}-${NS}`, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    companyIds.push(companyId);
    const plantId = (await prisma.plant.create({ data: { name: `P-${label}-${NS}`, zoneId } })).plantId;
    plantIds.push(plantId);

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: `SE ${tag}`, role: 'SERVICE_ENGINEER', phone: `ph-${tag}`, email: `${tag}@evidence.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({
      data: { engineerId: u.userId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 },
    });
    await prisma.seCoverage.create({ data: { seId: u.userId, plantId, coverageType: 'DEDICATED' } });

    const deviceId = String(9_286_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        hasOpenFailureCycle: true,
        latestGpsDatetime: new Date(NOW.getTime() - 90 * 60_000),
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
    return { zoneId, seId: u.userId, ticketId: ticket.ticketId };
  };

  const newRun = async (status: 'RUNNING' | 'ABORTED' = 'RUNNING'): Promise<bigint> => {
    const run = await prisma.dispatchRun.create({
      data: {
        trigger: 'CRON',
        startedAt: NOW,
        configSnapshot: {},
        status,
        finishedAt: status === 'RUNNING' ? null : NOW,
      },
    });
    runIds.push(run.runId);
    return run.runId;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    rec = new RecommenderService(prisma, new CandidateSelectionService(prisma));
  });

  afterAll(async () => {
    await prisma.dispatchDecisionTrace.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.dispatchRunZone.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.dispatchRun.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seCoverage.deleteMany({ where: { plantId: { in: plantIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: plantIds } } });
    await prisma.company.deleteMany({ where: { companyId: { in: companyIds } } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: zoneIds } } });
    await prisma.onModuleDestroy();
  });

  /**
   * The whole AC, on the rows. Two things have to be true at once and they used to be in tension: the
   * next run must re-evaluate freshly (no inherited suggestion, no wedge), and the dead run's trace
   * must still be there to read.
   */
  it("retires the aborted run's suggestion instead of deleting it — the decision trace survives", async () => {
    const s = await seedZone('evidence');

    // What a run that died mid-flight leaves: it suggested, then its process stopped existing and the
    // reaper marked it ABORTED. The trace is the only record of what it intended.
    const abortedRun = await newRun('ABORTED');
    const orphan = await prisma.recommendation.create({
      data: {
        ticketId: s.ticketId,
        seId: s.seId,
        status: 'SUGGESTED',
        path: 'MORNING_BATCH',
        scoreBreakdown: { note: 'what the dead run thought' },
        runId: abortedRun,
      },
    });
    await prisma.dispatchDecisionTrace.create({
      data: {
        runId: abortedRun,
        recommendationId: orphan.recommendationId,
        ticketId: s.ticketId,
        zoneId: s.zoneId,
        seId: s.seId,
        trace: { why: 'the dead run picked this SE' },
      },
    });

    const freshRun = await newRun();
    const out = await rec.runForZone(s.zoneId, { now: NOW, runId: freshRun });

    // Re-evaluated freshly: #126's guarantee is untouched, the zone is not wedged, and the live
    // suggestion belongs to the new run.
    expect(out.recommended).toBe(1);
    const live = await prisma.recommendation.findMany({ where: { ticketId: s.ticketId, status: 'SUGGESTED' } });
    expect(live).toHaveLength(1);
    expect(live[0].runId).toBe(freshRun);

    // And the dead run's row is retired, not gone — so its trace is still answerable.
    const retired = await prisma.recommendation.findUnique({
      where: { recommendationId: orphan.recommendationId },
    });
    expect(retired?.status).toBe('RETIRED');
    const trace = await prisma.dispatchDecisionTrace.findFirst({ where: { runId: abortedRun } });
    expect(trace).not.toBeNull();
    expect(trace?.trace).toEqual({ why: 'the dead run picked this SE' });
  });
});
