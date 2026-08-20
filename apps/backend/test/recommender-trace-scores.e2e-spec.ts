import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { DispatchRunService } from '../src/scheduling/dispatch-run.service';

/**
 * #266 slice 2 — the decision trace stops explaining the decision wrongly.
 *
 * The trace is the "why this SE" surface: it is what the transparency drawer renders and what an
 * operator reads when they disagree with a dispatch. Three things in it were false.
 *
 * **① Runner-up scores were the WINNER's score** (the defect the issue cites at `recommender.service.ts:687`,
 * with an in-code TODO admitting it). Every passing runner-up was scored with `scoreCandidate(features,
 * weights, multiplier)` — one `multiplier`, the one computed for the chosen SE. While every candidate
 * scored identically that was merely redundant. Q-A made the multiplier candidate-specific, so it
 * became actively wrong: a runner-up who has never been to the plant is shown carrying the winner's
 * cluster bonus, and the trace reports a tie where the engine actually saw a difference. The TODO
 * predicted exactly this and expected #267's distance to trigger it; clustering got there first.
 *
 * **② `scoreDegenerate` was computed from distance alone** — `distanceFromPrevStopKm === null ||
 * weights.distance === 0` — meaning "all candidates score identically, so precedence decided, and the
 * trace says so". After Q-A that flag is a lie on precisely the tickets that matter: clustering
 * separates two candidates, the score genuinely decides, and the trace still claims precedence did it.
 * It is now derived from the actual spread of the scores that were computed, which is the only thing
 * that can stay true as more per-candidate terms arrive (#267's distance next).
 *
 * **③ Candidates in a losing tier were traced as `PASSED` with a score**, as though they had been
 * weighed and lost on merit. They were never scored at all — the winning tier is decided first and the
 * score is only ever consulted within it. They are now `TIER_NOT_REACHED` with a null score, which is
 * what actually happened to them.
 */
const NS = Date.now();
const NOW = new Date('2026-08-05T06:00:00Z');
const DAY = new Date('2026-08-05T00:00:00Z');

describe('#266 — the decision trace tells the truth about how the SE was chosen', () => {
  let prisma: PrismaService;
  let rec: RecommenderService;
  let runs: DispatchRunService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let runId: bigint;

  /** Two DEDICATED candidates (the winning tier) and one MULTI_PLANT (a tier never reached). */
  let dedClustered: string;
  let dedFresh: string;
  let multi: string;

  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  let subject: string;

  const makeSe = async (coverageType: 'DEDICATED' | 'MULTI_PLANT'): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@tr.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({
      data: { engineerId: u.userId, coverageType, zoneId, dailyCapacity: 10 },
    });
    await prisma.seCoverage.create({ data: { seId: u.userId, plantId, coverageType } });
    return u.userId;
  };

  const makeTicket = async (): Promise<string> => {
    const deviceId = String(26_601_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        hasOpenFailureCycle: true,
        latestGpsDatetime: new Date(NOW.getTime() - 180 * 60_000),
        plantId,
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
        plantId,
        companyId,
        companyTier: 'GOLD',
        lastStateChangedAt: NOW,
      },
    });
    ticketIds.push(t.ticketId);
    return t.ticketId;
  };

  /** A live, already-committed stop at the plant for the target day — what Q-A seeds clustering from. */
  const giveExistingStopAtPlant = async (se: string): Promise<void> => {
    const schedule = await prisma.workSchedule.create({
      data: { seId: se, zoneId, dateFrom: DAY, dateTo: DAY, status: 'ACTIVE', dispatchedAt: NOW },
    });
    const batch = await prisma.plantBatchAssignment.create({
      data: { scheduleId: schedule.scheduleId, plantId, seId: se, status: 'AUTO_ASSIGNED', stopSequence: 1 },
    });
    const ticketId = await makeTicket();
    await prisma.ticket.update({ where: { ticketId }, data: { assignmentState: 'FORMALLY_ASSIGNED' } });
    await prisma.batchAssignmentTicket.create({ data: { batchId: batch.batchId, ticketId, sortOrder: 1 } });
  };

  const traceFor = async (ticketId: string) => {
    const row = await prisma.dispatchDecisionTrace.findFirstOrThrow({ where: { runId, ticketId } });
    return row.trace as Record<string, any>;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    rec = new RecommenderService(prisma, new CandidateSelectionService(prisma));
    runs = new DispatchRunService(prisma, rec, new BatchAssignmentService(prisma));

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
    await prisma.systemSetting.upsert({
      where: { key: 'plant_cluster_multiplier' },
      create: { key: 'plant_cluster_multiplier', value: 1.25 },
      update: { value: 1.25 },
    });

    zoneId = (await prisma.zone.create({ data: { name: 'Z-tr-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-tr-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-tr-' + NS, zoneId } })).plantId;

    dedClustered = await makeSe('DEDICATED');
    dedFresh = await makeSe('DEDICATED');
    multi = await makeSe('MULTI_PLANT');

    // Only one of the two DEDICATED candidates is already going to this plant, so the winning tier
    // holds two candidates with genuinely DIFFERENT scores — the situation in which every one of the
    // three trace defects becomes observable rather than merely redundant.
    await giveExistingStopAtPlant(dedClustered);
    subject = await makeTicket();

    const outcome = await runs.runForActiveZones(NOW, { zoneId, trigger: 'MANUAL' });
    expect(outcome.result).toBe('RAN');
    const row = await prisma.dispatchRunZone.findFirstOrThrow({ where: { zoneId }, orderBy: { id: 'desc' } });
    runId = row.runId;
  });

  afterAll(async () => {
    const ledger = await prisma.dispatchRun.findMany({
      where: { zoneRows: { some: { zoneId } } },
      select: { runId: true },
    });
    const schedules = await prisma.workSchedule.findMany({ where: { zoneId }, select: { scheduleId: true } });
    const batches = await prisma.plantBatchAssignment.findMany({
      where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } },
      select: { batchId: true },
    });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.workSchedule.deleteMany({ where: { zoneId } });
    await prisma.dispatchDecisionTrace.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.dispatchRun.deleteMany({ where: { runId: { in: ledger.map((r) => r.runId) } } });
    await prisma.auditLog.deleteMany({
      where: { entityType: 'dispatch_run', entityId: { in: ledger.map((r) => r.runId.toString()) } },
    });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seCoverage.deleteMany({ where: { seId: { in: userIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('AC — a runner-up carries its OWN score, not the winner\'s', async () => {
    const trace = await traceFor(subject);
    expect(trace.chosen.seId).toBe(dedClustered);

    const runnerUp = trace.runnersUp.find((r: any) => r.seId === dedFresh);
    expect(runnerUp).toBeDefined();
    expect(runnerUp.verdict).toBe('PASSED');

    // The whole defect in one assertion. Both candidates pass every filter and share an identical
    // base, so the ONLY thing separating them is the cluster bonus the winner earns and the runner-up
    // does not. Scoring the runner-up with the winner's multiplier makes these two numbers equal and
    // the trace then reports a tie the engine never saw.
    expect(runnerUp.score).toBeLessThan(trace.chosen.score ?? Number.POSITIVE_INFINITY);
    // And it is the runner-up's real score: the same base, with no cluster bonus applied.
    expect(runnerUp.score).toBeCloseTo(trace.chosen.breakdown.baseScore, 10);
  });

  it('AC — the winner\'s trace carries its own score and the clustering that produced it', async () => {
    const trace = await traceFor(subject);
    // Q-A requires the breakdown to SHOW the clustering contribution rather than fold it away, so the
    // reader can see why the winner beat an otherwise identical peer.
    expect(trace.chosen.breakdown.clusterMultiplier).toBe(1.25);
    expect(trace.chosen.score).toBeCloseTo(trace.chosen.breakdown.baseScore * 1.25, 10);
  });

  it('AC — a candidate in a losing tier is TIER_NOT_REACHED, not scored-and-lost', async () => {
    const trace = await traceFor(subject);
    const lower = trace.runnersUp.find((r: any) => r.seId === multi);
    expect(lower).toBeDefined();

    // It passed every hard filter, so calling it DROPPED would be false; it was never scored, so
    // calling it PASSED with a score would be false too. The winning tier is decided first and the
    // score is only ever consulted inside it — this is the verdict that says exactly that.
    expect(lower.verdict).toBe('TIER_NOT_REACHED');
    expect(lower.score).toBeNull();
    expect(lower.dropReason).toBeNull();
  });

  it('AC — `scoreDegenerate` reflects whether the scores actually differed', async () => {
    const trace = await traceFor(subject);
    // It used to be derived from distance alone ("distance is the only per-SE component and it is
    // null, so everything ties"). Clustering made that false without touching the expression: here
    // the score genuinely decided the winner, and a trace claiming precedence did it would send an
    // operator looking for a coverage explanation that does not exist.
    expect(trace.scoreDegenerate).toBe(false);
  });
});
