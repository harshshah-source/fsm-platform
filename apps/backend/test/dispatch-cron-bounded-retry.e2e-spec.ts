import {
  DEFAULT_DISPATCH_RETRY_DEADLINE_MIN,
  DEFAULT_DISPATCH_RETRY_INTERVAL_MS,
  DEFAULT_DISPATCH_STALE_RUN_MIN,
  readDispatchRetryPolicy,
} from '../src/scheduling/dispatch-cron';
import { PrismaService } from '../src/prisma/prisma.service';
import type { RecommenderService } from '../src/recommender/recommender.service';
import type { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { DispatchRunService } from '../src/scheduling/dispatch-run.service';

/**
 * #260 — the 05:00 run waits out brief contention instead of skipping a zone until tomorrow.
 *
 * #259 shrank a refusal from the whole request to the single zone, which was the important half. The
 * half it left: a zone contended at 05:00:00 by something that finishes at 05:00:20 still gets
 * **nothing that day**, because the cron asks once and the next attempt is tomorrow. A collision
 * measured in seconds costing a zone its daily dispatch is the failure this closes.
 *
 * Asymmetric on purpose (#258 Q8.6): the CRON is patient because nobody is watching it, and a MANUAL
 * run is not, because an operator pressing a button wants an answer rather than a queue.
 *
 * **Patience lives in two places, and both are pinned here.** When every requested zone is held #259
 * opens no run row at all — its "a run which never happened leaves no history" rule — so there is
 * nothing for an in-run retry to retry *under*, and the waiting has to happen at admission. When some
 * zones are free the run opens immediately and the held ones are promoted in place later. Those are
 * genuinely different code paths with different ledger consequences, hence a test each.
 *
 * Real timers throughout: the thing under test is that the run is still open and still asking when
 * another connection lets go, and a fake clock would let the loop advance without the release ever
 * landing in the database.
 */
const NS = Date.now();

const stubRecommender = (): RecommenderService =>
  ({
    runForZone: async () => ({
      ticketsConsidered: 0,
      recommended: 0,
      unassignable: 0,
      withheldBelowThreshold: 0,
      bucketlessDropped: 0,
      componentBlockedWithheld: 0,
      assignmentThresholdHours: null,
      mode: 'DEFICIT',
      weightSetRef: 'retry-spec',
    }),
  }) as unknown as RecommenderService;

const stubDispatch = (): BatchAssignmentService =>
  ({ dispatchForZone: async () => ({ schedules: 0, batches: 0, tickets: 0 }) }) as unknown as BatchAssignmentService;

describe('#260 — the cron waits out brief contention (e2e)', () => {
  /** Two pools: the holder is written over a second connection, as another process would. */
  let prisma: PrismaService;
  let prismaHolder: PrismaService;
  let service: DispatchRunService;
  let zoneId: bigint;
  let plantId: bigint;
  const holderRunIds: bigint[] = [];

  /** Stage a live claim on this spec's zone, exactly as a run in flight elsewhere would leave one. */
  const holdZone = async (): Promise<bigint> => {
    const run = await prismaHolder.dispatchRun.create({
      data: {
        trigger: 'MANUAL',
        actorRole: 'OPERATIONS_HEAD',
        startedAt: new Date(),
        heartbeatAt: new Date(),
        configSnapshot: {},
      },
    });
    await prismaHolder.dispatchRunZone.create({
      data: { runId: run.runId, zoneId, status: 'RUNNING', startedAt: new Date() },
    });
    holderRunIds.push(run.runId);
    return run.runId;
  };

  /** Release the holder the way a real run does — finalize the claim, leaving the run row behind. */
  const releaseZone = async (runId: bigint): Promise<void> => {
    await prismaHolder.dispatchRunZone.updateMany({
      where: { runId, zoneId, status: 'RUNNING' },
      data: { status: 'DONE', finishedAt: new Date() },
    });
  };

  /** Every run this spec's own service opened — an unscoped run touches zones we do not own. */
  const runsWeOpened = () => prisma.dispatchRun.findMany({ where: { reason: { startsWith: `r260-${NS}` } } });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    prismaHolder = new PrismaService();
    await prismaHolder.onModuleInit();
    zoneId = (await prisma.zone.create({ data: { name: `Z-retry-${NS}` } })).zoneId;
    plantId = (await prisma.plant.create({ data: { name: `P-retry-${NS}`, zoneId } })).plantId;
    service = new DispatchRunService(prisma, stubRecommender(), stubDispatch());
  });

  afterEach(async () => {
    // Delete by RUN, not by zone: an unscoped run claims every active zone, and leaving those rows
    // behind would refuse those zones to whatever spec file runs next.
    const mine = (await runsWeOpened()).map((r) => r.runId);
    await prisma.dispatchRunZone.deleteMany({ where: { runId: { in: [...mine, ...holderRunIds] } } });
    await prisma.dispatchRun.deleteMany({ where: { runId: { in: [...mine, ...holderRunIds] } } });
    holderRunIds.length = 0;
  });

  afterAll(async () => {
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
    await prismaHolder.onModuleDestroy();
  });

  /**
   * AC-1, admission path — every requested zone held, so no run row exists yet. The run has to be
   * patient *before* it has a ledger row, and while it waits it must still be writing nothing.
   */
  it('waits for the only zone it wants, then opens ONE run and dispatches it', async () => {
    const holderRunId = await holdZone();
    setTimeout(() => void releaseZone(holderRunId), 400);

    // Nothing may be written while it waits — #259's rule that a run which never happened leaves no
    // history has to survive the run becoming patient.
    const probe = setTimeout(async () => {
      expect(await runsWeOpened()).toHaveLength(0);
    }, 150);

    const outcome = await service.runForActiveZones(new Date(), {
      zoneId,
      trigger: 'CRON',
      reason: `r260-${NS}-admit`,
      retry: { intervalMs: 100, deadlineMs: 5_000 },
    });
    clearTimeout(probe);

    expect(outcome.result).toBe('RAN');
    if (outcome.result !== 'RAN') return;
    expect(outcome.summary.zoneOutcomes).toEqual([{ zoneId: zoneId.toString(), outcome: 'DONE' }]);
    expect(outcome.summary.zones).toBe(1);

    // AC-4 — one run row, not one per attempt.
    const mine = await runsWeOpened();
    expect(mine).toHaveLength(1);
    expect(mine[0].runId.toString()).toBe(outcome.summary.runId);
    expect(mine[0].status).toBe('SUCCESS');
    const rows = await prisma.dispatchRunZone.findMany({ where: { runId: mine[0].runId, zoneId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('DONE');
  }, 30_000);

  /**
   * AC-1, in-run path — some zones free, so the run opens at once and the held zone is recorded
   * CONTENDED. The retry has to promote that existing row rather than claim a new one: a run gets
   * exactly one row per zone (`@@unique([runId, zoneId])`), and the zone's whole story belongs on it.
   */
  it('promotes a CONTENDED zone in place when it frees, under the same run and the same row', async () => {
    const holderRunId = await holdZone();
    setTimeout(() => void releaseZone(holderRunId), 400);

    // Unscoped: the other active zones are free, so admission succeeds immediately and our zone is the
    // one that comes back CONTENDED — which is precisely the state the in-run retry exists for.
    const outcome = await service.runForActiveZones(new Date(), {
      trigger: 'CRON',
      reason: `r260-${NS}-inrun`,
      retry: { intervalMs: 100, deadlineMs: 5_000 },
    });

    expect(outcome.result).toBe('RAN');
    if (outcome.result !== 'RAN') return;
    const ours = outcome.summary.zoneOutcomes.find((z) => z.zoneId === zoneId.toString());
    expect(ours).toEqual({ zoneId: zoneId.toString(), outcome: 'DONE' });

    const mine = await runsWeOpened();
    expect(mine).toHaveLength(1);
    // Recovered every zone it was refused, so nothing partial actually happened.
    expect(mine[0].status).toBe('SUCCESS');

    const rows = await prisma.dispatchRunZone.findMany({ where: { runId: mine[0].runId, zoneId } });
    expect(rows).toHaveLength(1); // promoted in place, never a second row
    expect(rows[0].status).toBe('DONE');
    expect(rows[0].finishedAt).not.toBeNull();
    // The collision is still on the record. This run really was refused this zone at 05:00:00, and
    // `contended_with_run_id` is the only surviving trace of who by — promotion must not erase it.
    expect(rows[0].contendedWithRunId?.toString()).toBe(holderRunId.toString());
  }, 30_000);

  /**
   * AC-2 — held past the deadline. The zone keeps its CONTENDED row and the run is PARTIAL: patience
   * is bounded, and running out of it is reported, never silently swallowed (G7).
   */
  it('gives up at the deadline, leaving the zone CONTENDED and the run PARTIAL', async () => {
    const holderRunId = await holdZone(); // never released

    const outcome = await service.runForActiveZones(new Date(), {
      trigger: 'CRON',
      reason: `r260-${NS}-deadline`,
      retry: { intervalMs: 80, deadlineMs: 300 },
    });

    expect(outcome.result).toBe('RAN');
    if (outcome.result !== 'RAN') return;
    expect(outcome.summary.zoneOutcomes.find((z) => z.zoneId === zoneId.toString())).toMatchObject({
      outcome: 'CONTENDED',
      holder: { runId: holderRunId.toString() },
    });

    const mine = await runsWeOpened();
    expect(mine[0].status).toBe('PARTIAL');
    const rows = await prisma.dispatchRunZone.findMany({ where: { runId: mine[0].runId, zoneId } });
    expect(rows[0].status).toBe('CONTENDED');
  }, 30_000);

  /**
   * AC-3 — a manual run never waits, asserted on the clock. An operator who pressed a button gets the
   * truth immediately; turning their click into a silent queue would be worse than a refusal.
   */
  it('never makes a MANUAL run wait, however patient the config is', async () => {
    await holdZone();

    const startedAt = Date.now();
    const outcome = await service.runForActiveZones(new Date(), {
      zoneId,
      trigger: 'MANUAL',
      reason: `r260-${NS}-manual`,
      // A policy that would keep a CRON run waiting ten seconds. A manual run must ignore it entirely.
      retry: { intervalMs: 500, deadlineMs: 10_000 },
    });
    const elapsed = Date.now() - startedAt;

    expect(outcome.result).toBe('CONFLICT');
    // Generous enough not to be flaky on a loaded box, tight enough that a single 500 ms wait fails it.
    expect(elapsed).toBeLessThan(400);
    // And it left no history, exactly as #259 requires of a refusal.
    expect(await runsWeOpened()).toHaveLength(0);
  }, 30_000);

  /**
   * The refusal a patient run eventually gives is still #213's refusal: it names the holder, and it
   * writes nothing. Patience must not turn "every zone is busy" into an empty run row.
   */
  it('still refuses with zero rows when the wait runs out on a single-zone run', async () => {
    const holderRunId = await holdZone(); // never released

    const outcome = await service.runForActiveZones(new Date(), {
      zoneId,
      trigger: 'CRON',
      reason: `r260-${NS}-giveup`,
      retry: { intervalMs: 80, deadlineMs: 300 },
    });

    expect(outcome.result).toBe('CONFLICT');
    if (outcome.result !== 'CONFLICT') return;
    expect(outcome.inFlight).toEqual([
      expect.objectContaining({ zoneId: zoneId.toString(), runId: holderRunId.toString() }),
    ]);
    expect(await runsWeOpened()).toHaveLength(0);
  }, 30_000);

  it('readDispatchRetryPolicy: defaults, env overrides, and 0 as the documented off switch', () => {
    expect(readDispatchRetryPolicy({})).toEqual({
      intervalMs: DEFAULT_DISPATCH_RETRY_INTERVAL_MS,
      deadlineMs: DEFAULT_DISPATCH_RETRY_DEADLINE_MIN * 60_000,
    });
    expect(readDispatchRetryPolicy({ DISPATCH_RETRY_INTERVAL_MS: '5000' }).intervalMs).toBe(5000);
    expect(readDispatchRetryPolicy({ DISPATCH_RETRY_DEADLINE_MS: '90000' }).deadlineMs).toBe(90_000);
    // The rollback switch the issue specifies: deadline 0 restores try-once. It has to survive the
    // fallback that rescues garbage, which is why the guard is `>= 0` and not `> 0`.
    expect(readDispatchRetryPolicy({ DISPATCH_RETRY_DEADLINE_MS: '0' }).deadlineMs).toBe(0);
    expect(readDispatchRetryPolicy({ DISPATCH_RETRY_DEADLINE_MS: 'nonsense' }).deadlineMs).toBe(
      DEFAULT_DISPATCH_RETRY_DEADLINE_MIN * 60_000,
    );
  });

  /**
   * The invariant #261 wrote down and #260 is the other half of: **reap ≤ retry deadline.** If a
   * crashed holder could outlive the cron's patience, the morning run would spend its whole window
   * waiting behind a zombie claim and then give up — the starvation both issues exist to prevent.
   */
  it('keeps the reap threshold inside the retry deadline', () => {
    expect(DEFAULT_DISPATCH_STALE_RUN_MIN * 60_000).toBeLessThanOrEqual(
      DEFAULT_DISPATCH_RETRY_DEADLINE_MIN * 60_000,
    );
  });
});
