import { PrismaService } from '../src/prisma/prisma.service';
import type { RecommenderService } from '../src/recommender/recommender.service';
import type { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { DispatchRunService } from '../src/scheduling/dispatch-run.service';
import { DispatchTransparencyQueryService } from '../src/scheduling/dispatch-transparency-query.service';

/**
 * #261 — a dead process can never hold a zone forever, and a reaped zombie can never resurrect itself.
 *
 * #259 made admission a row, which is what made a refusal durable across processes — and durability
 * cuts both ways. `releaseStrandedClaims` covers a run that *unwinds*: its `finally` finalizes whatever
 * claims it still holds. A process that **dies** never reaches a `finally`, so it leaves a RUNNING
 * `dispatch_run_zones` row that refuses that zone to every future run, forever. `dispatch-zone-claim-
 * admission.e2e-spec.ts` pins that claim surviving a restart; this spec is what reaps it.
 *
 * Liveness is a heartbeat, not a start time — the same correction #132 needed on the ingestion ledgers.
 * A dispatch run over many zones is legitimately long; reaping it for wall-clock age would hand its
 * zones to a second run while the first was still dispatching them.
 */
const NS = Date.now();

/** Parks a run inside the recommender so it can be reaped while genuinely mid-flight. */
const stubRecommender = (park: () => Promise<void> | null): RecommenderService =>
  ({
    runForZone: async () => {
      const held = park();
      if (held) await held;
      return {
        ticketsConsidered: 0,
        recommended: 0,
        unassignable: 0,
        withheldBelowThreshold: 0,
        bucketlessDropped: 0,
        componentBlockedWithheld: 0,
        assignmentThresholdHours: null,
        mode: 'DEFICIT',
        weightSetRef: 'reaper-spec',
      };
    },
  }) as unknown as RecommenderService;

const stubDispatch = (): BatchAssignmentService =>
  ({ dispatchForZone: async () => ({ schedules: 0, batches: 0, tickets: 0 }) }) as unknown as BatchAssignmentService;

describe('#261 — dispatch-run heartbeat, reaper and conditional finish (e2e)', () => {
  let prisma: PrismaService;
  let service: DispatchRunService;
  let zoneId: bigint;
  let plantId: bigint;
  const stagedRunIds: bigint[] = [];
  /** Set to park the next zone the recommender is asked for; cleared after every test. */
  let park: { promise: Promise<void>; release: () => void } | null = null;

  const HOUR_AGO = (): Date => new Date(Date.now() - 60 * 60 * 1000);

  /**
   * Stage the wreckage a killed process leaves: a RUNNING `dispatch_runs` row with a RUNNING claim
   * under it and nothing alive holding either. `heartbeatAt` is the dial the tests turn — an old beat
   * is a dead run, a fresh one is a slow but living run.
   */
  const stageAbandonedRun = async (heartbeatAt: Date | null, startedAt = HOUR_AGO()): Promise<bigint> => {
    const run = await prisma.dispatchRun.create({
      data: { trigger: 'CRON', status: 'RUNNING', startedAt, heartbeatAt, configSnapshot: {} },
    });
    await prisma.dispatchRunZone.create({
      data: { runId: run.runId, zoneId, status: 'RUNNING', startedAt },
    });
    stagedRunIds.push(run.runId);
    return run.runId;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    zoneId = (await prisma.zone.create({ data: { name: `Z-reap-${NS}` } })).zoneId;
    plantId = (await prisma.plant.create({ data: { name: `P-reap-${NS}`, zoneId } })).plantId;
    service = new DispatchRunService(prisma, stubRecommender(() => park?.promise ?? null), stubDispatch());
  });

  afterEach(async () => {
    // A test that fails while a run is parked would hang every later test behind its claim.
    park?.release();
    park = null;
    const mine = { zoneId };
    const runIds = (await prisma.dispatchRunZone.findMany({ where: mine, select: { runId: true } })).map((r) => r.runId);
    await prisma.dispatchRunZone.deleteMany({ where: mine });
    await prisma.dispatchRun.deleteMany({ where: { runId: { in: [...runIds, ...stagedRunIds] } } });
    stagedRunIds.length = 0;
  });

  afterAll(async () => {
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  /**
   * AC-1 — the whole point. Before this, the staged claim below refused zone `zoneId` to every run for
   * the rest of the database's life, and the only cure was an operator running SQL by hand.
   */
  it('reaps a dead run at the next admission: run ABORTED, claim freed, and the new run dispatches', async () => {
    const deadRunId = await stageAbandonedRun(HOUR_AGO());

    const outcome = await service.runForActiveZones(new Date(), { zoneId, trigger: 'MANUAL', reason: `reap-${NS}` });

    expect(outcome.result).toBe('RAN');
    if (outcome.result !== 'RAN') return;
    expect(outcome.summary.zoneOutcomes).toEqual([{ zoneId: zoneId.toString(), outcome: 'DONE' }]);

    const dead = await prisma.dispatchRun.findUniqueOrThrow({ where: { runId: deadRunId } });
    expect(dead.status).toBe('ABORTED');
    expect(dead.finishedAt).not.toBeNull();

    // The claim it was holding is terminal and says why, so the ledger reads as an abandonment rather
    // than a zone that quietly changed hands.
    const deadClaim = await prisma.dispatchRunZone.findFirstOrThrow({ where: { runId: deadRunId, zoneId } });
    expect(deadClaim.status).toBe('ERROR');
    expect(deadClaim.error).toContain('ABANDONED');
    expect(deadClaim.finishedAt).not.toBeNull();
  });

  /**
   * AC-3 — and the reason the beat exists at all. A reaper keyed on `started_at` cannot tell a run that
   * died from a run that is taking a while, so it eventually reaps a **live** run: frees the zones it
   * is actively dispatching, lets a second run in on top of it, and produces two runs writing the same
   * day plans. That failure is strictly worse than the one the reaper was built to fix.
   */
  it('leaves a slow-but-alive run alone — a fresh beat outlives an old startedAt', async () => {
    const slowRunId = await stageAbandonedRun(new Date(), HOUR_AGO());

    const reaped = await service.reapStaleDispatchRuns(new Date());

    expect(reaped).toEqual({ runs: 0, claims: 0 });
    const slow = await prisma.dispatchRun.findUniqueOrThrow({ where: { runId: slowRunId } });
    expect(slow.status).toBe('RUNNING');
    const claim = await prisma.dispatchRunZone.findFirstOrThrow({ where: { runId: slowRunId, zoneId } });
    expect(claim.status).toBe('RUNNING');

    // And it still holds the zone: a live run's claim must go on refusing, or the reaper has simply
    // moved the double-dispatch from its own write to the next admission's.
    const refused = await service.runForActiveZones(new Date(), { zoneId, trigger: 'MANUAL', reason: `slow-${NS}` });
    expect(refused.result).toBe('CONFLICT');
  });

  /**
   * The pre-heartbeat population. Every `dispatch_runs` row written before this column existed has a
   * NULL beat, and they are exactly the rows most likely to be stranded — so a reaper that only
   * understood the new column would arrive and do nothing for the mess it was built to clean up.
   */
  it('still reaps a run that never beat at all, falling back to startedAt', async () => {
    const ancientRunId = await stageAbandonedRun(null, HOUR_AGO());

    const reaped = await service.reapStaleDispatchRuns(new Date());

    expect(reaped).toEqual({ runs: 1, claims: 1 });
    expect((await prisma.dispatchRun.findUniqueOrThrow({ where: { runId: ancientRunId } })).status).toBe('ABORTED');
  });

  /** A live run beats per zone, so its silence is bounded by one zone rather than by the whole run. */
  it('beats after every zone it finishes', async () => {
    const before = new Date();
    const outcome = await service.runForActiveZones(new Date(), { zoneId, trigger: 'MANUAL', reason: `beat-${NS}` });

    expect(outcome.result).toBe('RAN');
    if (outcome.result !== 'RAN') return;
    const run = await prisma.dispatchRun.findUniqueOrThrow({ where: { runId: BigInt(outcome.summary.runId) } });
    expect(run.heartbeatAt).not.toBeNull();
    // Strictly after the run opened: the opening beat alone would satisfy "not null" and would be
    // `started_at` under another name.
    expect(run.heartbeatAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(run.heartbeatAt!.getTime()).toBeGreaterThan(run.startedAt.getTime());
  });

  /**
   * AC-2 — **zombie resurrect**, the defect half of #132 on the dispatch side.
   *
   * The reaper presumes a silent run is dead, and it is usually right. When it is wrong the run wakes
   * up and finalizes: an unconditional update then overwrites ABORTED with SUCCESS and re-stamps the
   * zone claim it no longer holds. That is worse than either state alone — the zone was handed to
   * somebody else the moment it was freed, so a run reporting SUCCESS over the top of that is a ledger
   * asserting two runs dispatched the same zone. Whoever wrote first wins, and a reaped run stays
   * reaped.
   */
  it("a reaped run's late finalize is a no-op — the run stays ABORTED and its claim stays freed", async () => {
    park = (() => {
      let release!: () => void;
      const promise = new Promise<void>((r) => (release = () => r()));
      return { promise, release };
    })();

    const running = service.runForActiveZones(new Date(), { zoneId, trigger: 'MANUAL', reason: `zombie-${NS}` });
    // Let it admit, open its claim, and reach the parked recommender.
    await new Promise((r) => setTimeout(r, 150));

    // Reaped from outside while genuinely mid-flight. An hour ahead of the beat it just took, which is
    // what a real ten-minute silence would look like to a later admission.
    const reaped = await service.reapStaleDispatchRuns(new Date(Date.now() + 60 * 60 * 1000));
    expect(reaped).toEqual({ runs: 1, claims: 1 });

    park.release();
    const outcome = await running;
    expect(outcome.result).toBe('RAN');
    if (outcome.result !== 'RAN') return;

    const run = await prisma.dispatchRun.findUniqueOrThrow({ where: { runId: BigInt(outcome.summary.runId) } });
    expect(run.status).toBe('ABORTED');
    // Its own totals must not land either: they describe work the ledger no longer credits to this run.
    expect(run.zones).toBe(0);

    const claim = await prisma.dispatchRunZone.findFirstOrThrow({ where: { runId: run.runId, zoneId } });
    expect(claim.status).toBe('ERROR');
    expect(claim.error).toContain('ABANDONED');
  });

  /**
   * The transparency surface — the issue asks for the new status to be *verified* reaching it rather
   * than assumed. A reaped run that renders as a blank cell, or worse as SUCCESS, would make the one
   * event this whole issue exists to record the one event an operator cannot see.
   */
  it('surfaces ABORTED to the transparency list and run detail', async () => {
    const deadRunId = await stageAbandonedRun(HOUR_AGO());
    await service.reapStaleDispatchRuns(new Date());

    const query = new DispatchTransparencyQueryService(prisma);
    const listed = (await query.listRuns({ role: 'OPERATIONS_HEAD', zoneId: null }, 100)).find(
      (r) => r.runId === deadRunId.toString(),
    );
    expect(listed?.status).toBe('ABORTED');

    const detail = await query.getRunDetail(deadRunId, { role: 'OPERATIONS_HEAD', zoneId: null });
    expect(detail?.status).toBe('ABORTED');
    // And the freed claim reads as this run's ERROR outcome on the zone card, not as a live one.
    expect(detail?.zones.find((z) => z.zoneId === zoneId.toString())?.outcome).toBe('ERROR');
  });
});
