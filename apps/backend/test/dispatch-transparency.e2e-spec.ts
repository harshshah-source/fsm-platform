import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { DispatchRunService } from '../src/scheduling/dispatch-run.service';
import { expectRan } from './dispatch-outcome';

/**
 * Batch-Assignment transparency — the dispatch-run ledger + per-ticket decision trace, observed at
 * the same seams the cron and the manual trigger drive. Observe-only: these tests also pin that the
 * dispatch outcome (who got what) is byte-identical to the pre-ledger behavior.
 *
 * Seam 1 (zone level): `runForZone`/`dispatchForZone` with a `runId` → `dispatch_decision_traces`
 * rows with the chosen SE's precedence context, per-filter drop COUNTS, top-5 runners-up, and the
 * NO_COVERAGE vs ALL_DROPPED emptied-pool distinction; `run_id` stamped on recommendations +
 * work_schedules.
 *
 * Seam 2 (run level): `runForActiveZones` → dispatch_runs ledger row (config snapshot at run start,
 * PARTIAL on a contained zone failure), per-zone rows, and the system-actor audit bracket.
 */
const NS = Date.now();
const NOW = new Date('2026-07-15T05:00:00Z');
const DAY = new Date('2026-07-15T00:00:00Z');

describe('dispatch transparency — per-ticket decision traces (seeded zone)', () => {
  let prisma: PrismaService;
  let recommender: RecommenderService;
  let dispatch: BatchAssignmentService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantCovered: bigint; // P1 — SE-A dedicated (cap 1) + SE-B multi-plant
  let plantNoCoverage: bigint; // P2 — zero candidates
  let plantInactiveSe: bigint; // P3 — only SE-C, inactive
  let seA: string;
  let seB: string;
  let seC: string;
  let runId: bigint;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  let t1: string, t2: string, t3: string, t4: string;

  const makeSe = async (tag: string, opts: { capacity: number; isActive?: boolean }): Promise<string> => {
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@trace.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({
      data: { engineerId: u.userId, coverageType: 'DEDICATED', zoneId, dailyCapacity: opts.capacity, isActive: opts.isActive ?? true },
    });
    return u.userId;
  };

  const makeTicket = async (plantId: bigint, gpsAgeMin: number): Promise<string> => {
    const deviceId = String(9_540_000_000 + (NS % 100_000) * 10 + deviceIds.length);
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
    recommender = new RecommenderService(prisma, new CandidateSelectionService(prisma));
    dispatch = new BatchAssignmentService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-trace-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-trace-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantCovered = (await prisma.plant.create({ data: { name: 'P-trace-cov-' + NS, zoneId } })).plantId;
    plantNoCoverage = (await prisma.plant.create({ data: { name: 'P-trace-none-' + NS, zoneId } })).plantId;
    plantInactiveSe = (await prisma.plant.create({ data: { name: 'P-trace-inact-' + NS, zoneId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    seA = await makeSe('A-' + tag, { capacity: 1 });
    seB = await makeSe('B-' + tag, { capacity: 10 });
    seC = await makeSe('C-' + tag, { capacity: 10, isActive: false });
    await prisma.seCoverage.create({ data: { seId: seA, plantId: plantCovered, coverageType: 'DEDICATED' } });
    await prisma.seCoverage.create({ data: { seId: seB, plantId: plantCovered, coverageType: 'MULTI_PLANT' } });
    await prisma.seCoverage.create({ data: { seId: seC, plantId: plantInactiveSe, coverageType: 'DEDICATED' } });

    // Canonical order within the same tier/bucket/rank cell: oldest inactive first → T1 before T2.
    t1 = await makeTicket(plantCovered, 120);
    t2 = await makeTicket(plantCovered, 60);
    t3 = await makeTicket(plantNoCoverage, 90);
    t4 = await makeTicket(plantInactiveSe, 90);

    runId = (await prisma.dispatchRun.create({ data: { trigger: 'MANUAL', configSnapshot: {} } })).runId;
    await recommender.runForZone(zoneId, { now: NOW, runId });
    await dispatch.dispatchForZone(zoneId, { dateFrom: DAY, dateTo: DAY, now: NOW, runId });
  });

  afterAll(async () => {
    await prisma.dispatchDecisionTrace.deleteMany({ where: { runId } });
    const schedules = await prisma.workSchedule.findMany({ where: { zoneId }, select: { scheduleId: true } });
    const batches = await prisma.plantBatchAssignment.findMany({
      where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } },
      select: { batchId: true },
    });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.workSchedule.deleteMany({ where: { zoneId } });
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.dispatchRun.deleteMany({ where: { runId } });
    await prisma.componentBlockedQueue.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seCoverage.deleteMany({ where: { seId: { in: userIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [plantCovered, plantNoCoverage, plantInactiveSe] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  const traceFor = async (ticketId: string) => {
    const row = await prisma.dispatchDecisionTrace.findFirstOrThrow({ where: { runId, ticketId } });
    return { row, trace: row.trace as Record<string, any> };
  };

  it('writes one trace per processed ticket, joined 1:1 to the run recommendations', async () => {
    const traces = await prisma.dispatchDecisionTrace.findMany({ where: { runId } });
    expect(traces).toHaveLength(4);
    const recs = await prisma.recommendation.findMany({ where: { runId } });
    expect(recs).toHaveLength(4);
    const recIds = new Set(recs.map((r) => r.recommendationId));
    for (const t of traces) expect(recIds.has(t.recommendationId)).toBe(true);
  });

  it('chosen SE trace: precedence context, capacity slot, cluster seed, TIER_NOT_REACHED runner-up', async () => {
    const { row, trace } = await traceFor(t1);
    expect(row.seId).toBe(seA);
    expect(row.zoneId).toBe(zoneId);
    expect(trace.candidatesTotal).toBe(2);
    expect(trace.passedCount).toBe(2);
    expect(trace.dropCounts).toEqual({});
    expect(trace.poolEmptyReason).toBeNull();
    expect(trace.scoreDegenerate).toBe(true);
    expect(trace.chosen).toMatchObject({
      seId: seA,
      coverageType: 'DEDICATED',
      precedenceRank: 1,
      plannerPlanned: false,
      plannerBias: false,
      clusterSeed: true,
      capacityAtDecision: { used: 1, cap: 1 },
    });
    expect(trace.runnersUp).toHaveLength(1);
    // Re-derived for #266, not blind-updated. seB is MULTI_PLANT and the winner seA is DEDICATED, so
    // the winning tier was DEDICATED and seB was **never scored** — the tier is chosen first and the
    // score is only ever consulted inside it. The old trace called seB `PASSED` and handed it a
    // number, which read as "it was weighed against seA and lost on merit". It was not weighed at all,
    // and the number it carried was seA's own score.
    expect(trace.runnersUp[0]).toMatchObject({
      seId: seB,
      coverageType: 'MULTI_PLANT',
      precedenceRank: 2,
      verdict: 'TIER_NOT_REACHED',
      plannerPlanned: false,
    });
    expect(trace.runnersUp[0].score).toBeNull();
    // Only one candidate was ever scored, so there was no spread — precedence really did decide here,
    // and the flag still says so. It is now derived from that fact rather than from distance being null.
    expect(trace.scoreDegenerate).toBe(true);
  });

  it('capacity fallback trace: OVER_CAPACITY drop count, DROPPED runner-up, and IS a cluster seed', async () => {
    const { row, trace } = await traceFor(t2);
    expect(row.seId).toBe(seB);
    expect(trace.dropCounts).toEqual({ OVER_CAPACITY: 1 });
    expect(trace.passedCount).toBe(1);
    expect(trace.chosen).toMatchObject({
      seId: seB,
      coverageType: 'MULTI_PLANT',
      precedenceRank: 2,
      // Re-derived for #266 Q-A, not blind-updated. `clusterSeed` used to be run-level — "is this the
      // first ticket at this plant this run", regardless of WHO it went to — so the fallback SE was
      // recorded as a cluster follow-on for a plant they had never visited. It is now per candidate:
      // seB is going to this plant for the first time today, so this decision genuinely IS their seed.
      clusterSeed: true,
      capacityAtDecision: { used: 1, cap: 10 },
    });
    const droppedA = trace.runnersUp.find((r: any) => r.seId === seA);
    expect(droppedA).toMatchObject({ verdict: 'DROPPED', dropReason: 'OVER_CAPACITY', score: null });
  });

  it('unassignable — coverage gap: NO_COVERAGE with an empty pool', async () => {
    const { row, trace } = await traceFor(t3);
    expect(row.seId).toBeNull();
    expect(trace.chosen).toBeNull();
    expect(trace.candidatesTotal).toBe(0);
    expect(trace.poolEmptyReason).toBe('NO_COVERAGE');
    expect(trace.runnersUp).toEqual([]);
  });

  it('unassignable — filters emptied the pool: ALL_DROPPED with drop counts', async () => {
    const { row, trace } = await traceFor(t4);
    expect(row.seId).toBeNull();
    expect(trace.candidatesTotal).toBe(1);
    expect(trace.poolEmptyReason).toBe('ALL_DROPPED');
    expect(trace.dropCounts).toEqual({ SE_UNAVAILABLE: 1 });
    expect(trace.runnersUp[0]).toMatchObject({ seId: seC, verdict: 'DROPPED', dropReason: 'SE_UNAVAILABLE', score: null });
  });

  it('stamps run_id on the dispatched work schedules and leaves the outcome unchanged', async () => {
    const schedules = await prisma.workSchedule.findMany({ where: { zoneId } });
    expect(schedules).toHaveLength(2); // SE-A and SE-B each got a Day Plan
    for (const s of schedules) expect(s.runId).toBe(runId);
    // Observe-only: the pre-ledger outcome is intact — T1→SE-A, T2→SE-B, both FORMALLY_ASSIGNED.
    const ours = await prisma.ticket.findMany({ where: { ticketId: { in: [t1, t2] } } });
    for (const t of ours) expect(t.assignmentState).toBe('FORMALLY_ASSIGNED');
  });
});

describe('dispatch transparency — run ledger lifecycle (runForActiveZones)', () => {
  let prisma: PrismaService;
  let zoneA: bigint;
  let zoneB: bigint;
  let plantA: bigint;
  let plantB: bigint;
  let runId: bigint;
  const actorUserId = randomUUID();

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    zoneA = (await prisma.zone.create({ data: { name: 'Z-ledger-A-' + NS } })).zoneId;
    zoneB = (await prisma.zone.create({ data: { name: 'Z-ledger-B-' + NS } })).zoneId;
    plantA = (await prisma.plant.create({ data: { name: 'P-ledger-A-' + NS, zoneId: zoneA } })).plantId;
    plantB = (await prisma.plant.create({ data: { name: 'P-ledger-B-' + NS, zoneId: zoneB } })).plantId;
  });

  afterAll(async () => {
    if (runId !== undefined) {
      await prisma.dispatchRunZone.deleteMany({ where: { runId } });
      await prisma.dispatchRun.deleteMany({ where: { runId } });
      await prisma.auditLog.deleteMany({ where: { entityType: 'dispatch_run', entityId: runId.toString() } });
    }
    await prisma.plant.deleteMany({ where: { plantId: { in: [plantA, plantB] } } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: [zoneA, zoneB] } } });
    await prisma.onModuleDestroy();
  });

  it('opens the ledger with a run-start config snapshot, records per-zone rows, finalizes PARTIAL, and audit-brackets the run', async () => {
    const zeroRec = { recommended: 0, unassignable: 0, mode: 'DEFICIT', weightSetRef: 'v1', ticketsConsidered: 0 };
    const recommender = {
      runForZone: vi.fn(async (zoneId: bigint) => {
        if (zoneId === zoneA)
          return {
            recommended: 2,
            unassignable: 1,
            mode: 'DEFICIT',
            weightSetRef: 'v1',
            ticketsConsidered: 3,
            unassignableReasons: { NO_COVERAGE: 1, ALL_DROPPED: 0, dropBuckets: {} },
          };
        if (zoneId === zoneB) throw new Error('zone B exploded');
        return zeroRec;
      }),
    };
    const dispatch = {
      dispatchForZone: vi.fn(async (zoneId: bigint) =>
        zoneId === zoneA ? { schedules: 1, batches: 2, tickets: 2 } : { schedules: 0, batches: 0, tickets: 0 },
      ),
    };

    const svc = new DispatchRunService(
      prisma,
      recommender as unknown as RecommenderService,
      dispatch as unknown as BatchAssignmentService,
    );
    const summary = expectRan(
      await svc.runForActiveZones(NOW, {
        trigger: 'MANUAL',
        actorUserId,
        actorRole: 'OPERATIONS_HEAD',
      }),
    );

    expect(summary.runId).toBeDefined();
    runId = BigInt(summary.runId!);
    expect(summary.errors).toEqual([{ zoneId: zoneB.toString(), message: 'zone B exploded' }]);

    // Ledger row: trigger + actor + PARTIAL (one contained zone failure) + totals + config snapshot.
    const run = await prisma.dispatchRun.findUniqueOrThrow({ where: { runId } });
    expect(run.trigger).toBe('MANUAL');
    expect(run.actorUserId).toBe(actorUserId);
    expect(run.actorRole).toBe('OPERATIONS_HEAD');
    expect(run.status).toBe('PARTIAL');
    expect(run.finishedAt).not.toBeNull();
    expect(run.schedules).toBeGreaterThanOrEqual(1);
    expect(run.ticketsDispatched).toBeGreaterThanOrEqual(2);
    expect(run.recommended).toBeGreaterThanOrEqual(2);
    expect(run.unassignable).toBeGreaterThanOrEqual(1);
    const snapshot = run.configSnapshot as Record<string, any>;
    expect(Array.isArray(snapshot.priorityRules)).toBe(true);
    expect(snapshot.settings).toBeDefined();
    expect(snapshot.capacity).toBeDefined();
    expect(snapshot.scheduler).toHaveProperty('businessSweepsEnabled');

    // Per-zone rows: healthy zone carries its totals + mode; failed zone carries the error.
    const zoneRows = await prisma.dispatchRunZone.findMany({ where: { runId } });
    const rowA = zoneRows.find((z) => z.zoneId === zoneA);
    expect(rowA).toMatchObject({
      mode: 'DEFICIT',
      weightSetRef: 'v1',
      ticketsConsidered: 3,
      recommended: 2,
      unassignable: 1,
      schedules: 1,
      batches: 2,
      ticketsDispatched: 2,
      error: null,
    });
    expect((rowA!.unassignableReasons as Record<string, any>).NO_COVERAGE).toBe(1);
    const rowB = zoneRows.find((z) => z.zoneId === zoneB);
    expect(rowB!.error).toContain('zone B exploded');
    expect(rowB!.mode).toBeNull();

    // System-actor audit bracket.
    const audits = await prisma.auditLog.findMany({
      where: { entityType: 'dispatch_run', entityId: runId.toString() },
      orderBy: { id: 'asc' },
    });
    expect(audits.map((a) => a.action)).toEqual(['DISPATCH_RUN_STARTED', 'DISPATCH_RUN_FINISHED']);
    expect(audits[0].actorId).toBe(actorUserId);
    expect((audits[1].metadata as Record<string, any>).status).toBe('PARTIAL');
  });
});
