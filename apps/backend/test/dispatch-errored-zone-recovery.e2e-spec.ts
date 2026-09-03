import { istDate } from '../src/common/ist-day';
import { PrismaService } from '../src/prisma/prisma.service';
import type { RecommenderService } from '../src/recommender/recommender.service';
import type { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { DispatchRunService } from '../src/scheduling/dispatch-run.service';

/**
 * #319 (forensics AR-13) — a zone lost to a *contained* error gets the same day back as one lost to
 * process death.
 *
 * #286 gave the crashed zone a bounded same-day re-dispatch, and deliberately scoped the marks to the
 * reaper. The result was an asymmetry pointing the wrong way: kill the process and the zone is marked,
 * re-dispatched and reported; let a zone throw inside a live run — or let the run unwind with the
 * claim still open — and the failure is recorded on the ledger and then nothing ever asks for that
 * zone again until 05:00 tomorrow. **The worse failure had the better recovery.**
 *
 * Both losses end at the same place: a `dispatch_run_zones` row finalized ERROR. So that, and not the
 * cause, is what marks — and the mark is the one `markZonesForRecovery` the reaper already writes, so
 * the #286 collector owns the zone afterwards with no new machinery, no new state and no second budget.
 */
const NS = Date.now();

/** Set to a message to make the next zone's recommender blow up; cleared after every test. */
let zoneFailure: string | null = null;

const stubRecommender = (): RecommenderService =>
  ({
    runForZone: async () => {
      if (zoneFailure) throw new Error(zoneFailure);
      return {
        ticketsConsidered: 0,
        recommended: 0,
        unassignable: 0,
        withheldBelowThreshold: 0,
        bucketlessDropped: 0,
        componentBlockedWithheld: 0,
        assignmentThresholdHours: null,
        mode: 'DEFICIT',
        weightSetRef: 'errored-zone-recovery-spec',
      };
    },
  }) as unknown as RecommenderService;

const stubDispatch = (): BatchAssignmentService =>
  ({ dispatchForZone: async () => ({ schedules: 0, batches: 0, tickets: 0 }) }) as unknown as BatchAssignmentService;

/**
 * A client whose **successful** zone finalize throws once — the one injection that leaves a claim
 * RUNNING while the run unwinds around it, which is exactly the state `releaseStrandedClaims` exists
 * for. Keyed on `data.status === 'DONE'` rather than on a call count, because the reaper and the
 * release itself write the same delegate with `status: 'ERROR'` and a counter would hit the wrong one.
 */
function finalizeFailsOnce(prisma: PrismaService): PrismaService {
  let fired = false;
  return new Proxy(prisma, {
    get(target, prop, receiver) {
      if (prop !== 'dispatchRunZone') {
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      const delegate = Reflect.get(target, prop, receiver) as Record<string, unknown>;
      return new Proxy(delegate, {
        get(d, dp) {
          const fn = Reflect.get(d, dp);
          if (dp !== 'updateMany' || typeof fn !== 'function') return fn;
          return (...args: unknown[]) => {
            const data = (args[0] as { data?: { status?: string } } | undefined)?.data;
            if (!fired && data?.status === 'DONE') {
              fired = true;
              throw new Error('finalize lost its connection');
            }
            return (fn as (...a: unknown[]) => unknown).apply(d, args);
          };
        },
      });
    },
  }) as PrismaService;
}

describe('#319 — a zone lost to a contained error gets the same recovery as a crashed one', () => {
  let prisma: PrismaService;
  let service: DispatchRunService;

  let zoneId: bigint;
  let plantId: bigint;
  const stagedRunIds: bigint[] = [];

  const HOUR_AGO = (): Date => new Date(Date.now() - 60 * 60 * 1000);

  /** The wreckage a killed process leaves — #286's own staging, reused to test the two together. */
  const stageAbandonedRun = async (): Promise<bigint> => {
    const startedAt = HOUR_AGO();
    const run = await prisma.dispatchRun.create({
      data: { trigger: 'CRON', status: 'RUNNING', startedAt, heartbeatAt: HOUR_AGO(), configSnapshot: {} },
    });
    await prisma.dispatchRunZone.create({ data: { runId: run.runId, zoneId, status: 'RUNNING', startedAt } });
    stagedRunIds.push(run.runId);
    return run.runId;
  };

  /** A run that is alive right now and holding this zone — so admission is refused rather than reaped. */
  const stageLiveHolder = async (): Promise<bigint> => {
    const run = await prisma.dispatchRun.create({
      data: { trigger: 'CRON', status: 'RUNNING', startedAt: new Date(), heartbeatAt: new Date(), configSnapshot: {} },
    });
    await prisma.dispatchRunZone.create({
      data: { runId: run.runId, zoneId, status: 'RUNNING', startedAt: new Date() },
    });
    stagedRunIds.push(run.runId);
    return run.runId;
  };

  const runZone = (now: Date, svc: DispatchRunService = service) =>
    svc.runForActiveZones(now, { trigger: 'CRON', zoneId, retry: { intervalMs: 0, deadlineMs: 0 } });

  const markFor = () => prisma.dispatchZoneRecovery.findFirst({ where: { zoneId } });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    zoneId = (await prisma.zone.create({ data: { name: `Z-err-rec-${NS}` } })).zoneId;
    plantId = (await prisma.plant.create({ data: { name: `P-err-rec-${NS}`, zoneId } })).plantId;
    service = new DispatchRunService(prisma, stubRecommender(), stubDispatch());
  });

  beforeEach(async () => {
    // One Postgres is shared by the whole suite and other specs leave abandoned claims behind. Draining
    // them — and the marks that drain produces — is what makes "exactly one mark" a fact about this
    // zone rather than about whatever ran before it. Same reasoning as `dispatch-crashed-zone-recovery`.
    await service.reapStaleDispatchRuns(new Date());
    await prisma.dispatchZoneRecovery.deleteMany({});
  });

  afterEach(async () => {
    zoneFailure = null;
    await prisma.dispatchZoneRecovery.deleteMany({});
    const runIds = (await prisma.dispatchRunZone.findMany({ where: { zoneId }, select: { runId: true } })).map(
      (r) => r.runId,
    );
    await prisma.dispatchRunZone.deleteMany({ where: { zoneId } });
    await prisma.dispatchRun.deleteMany({ where: { runId: { in: [...runIds, ...stagedRunIds] } } });
    stagedRunIds.length = 0;
  });

  afterAll(async () => {
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  /**
   * AC1, the in-run half. A zone that throws is contained — that is the design, and it stays — but
   * containment was being read as closure: the ledger said ERROR and nothing followed.
   */
  it('a zone that throws inside a live run is marked PENDING for the same day', async () => {
    const now = new Date();
    zoneFailure = `zone ${zoneId} blew up mid-run`;

    const outcome = await runZone(now);
    expect(outcome.result).toBe('RAN');
    if (outcome.result !== 'RAN') return;
    expect(outcome.summary.zoneOutcomes[0]).toMatchObject({ zoneId: zoneId.toString(), outcome: 'ERROR' });

    const mark = await markFor();
    expect(mark).not.toBeNull();
    expect(mark!.state).toBe('PENDING');
    expect(mark!.attempts).toBe(0);
    // The run that lost the zone is named on the mark, exactly as the reaper names the dead one.
    expect(mark!.markedByRunId).toBe(BigInt(outcome.summary.runId));
    expect(mark!.businessDate.toISOString().slice(0, 10)).toBe(istDate(now).toISOString().slice(0, 10));
  });

  /**
   * AC1 — and the point of marking at all: the #286 collector takes it from here, through the ordinary
   * admission path. The DONE claim on a *different* run is the evidence it did not take a private route.
   */
  it('the collector then re-dispatches it the same day, through the ordinary admission path', async () => {
    zoneFailure = `zone ${zoneId} blew up mid-run`;
    const failed = await runZone(new Date());
    zoneFailure = null;

    const out = await service.recoverMarkedZones(new Date());

    expect(out).toMatchObject({ attempted: 1, recovered: 1, exhausted: 0, expired: 0, deferred: 0 });
    const mark = await markFor();
    expect(mark!.state).toBe('RECOVERED');
    expect(mark!.attempts).toBe(1);
    expect(mark!.resolvedAt).not.toBeNull();

    const claim = await prisma.dispatchRunZone.findFirstOrThrow({ where: { zoneId, status: 'DONE' } });
    if (failed.result === 'RAN') expect(claim.runId).not.toBe(BigInt(failed.summary.runId));
    expect((await prisma.dispatchRun.findUniqueOrThrow({ where: { runId: claim.runId } })).status).toBe('SUCCESS');
  });

  /**
   * AC1, the other half. `releaseStrandedClaims` runs in a `finally`: it covers a run that throws,
   * is cancelled, or otherwise unwinds — the case the reaper explicitly *cannot* reach, because the
   * process is alive and the run row is about to be finalized by its own code.
   *
   * Staged by making the successful finalize throw, which is the one injection that leaves a claim
   * RUNNING while the run unwinds around it.
   */
  it('a claim left open when the run unwinds is marked too, not only freed', async () => {
    const brittle = new DispatchRunService(finalizeFailsOnce(prisma), stubRecommender(), stubDispatch());

    await expect(runZone(new Date(), brittle)).rejects.toThrow('finalize lost its connection');

    // The claim was released — that part is #261's and was already true.
    const claim = await prisma.dispatchRunZone.findFirstOrThrow({ where: { zoneId } });
    expect(claim.status).toBe('ERROR');
    expect(claim.error).toContain('without finalizing');

    // …and now the day it lost is owed, rather than silently gone.
    const mark = await markFor();
    expect(mark).not.toBeNull();
    expect(mark!.state).toBe('PENDING');
    expect(mark!.attempts).toBe(0);
  });

  /** A zone that dispatched is not owed a day — the whole rule is "finalized ERROR", nothing wider. */
  it('a zone that finishes DONE is never marked', async () => {
    const outcome = await runZone(new Date());
    expect(outcome.result).toBe('RAN');
    expect(await markFor()).toBeNull();
  });

  /**
   * #286's own rule, which this must not bend: **busy is not broken.** A zone refused because somebody
   * live holds it has lost nothing yet — the holder is dispatching it — and marking it would charge a
   * healthy zone against a budget meant for broken ones.
   */
  it('a zone refused at admission is never marked', async () => {
    await stageLiveHolder();

    const outcome = await runZone(new Date());

    expect(outcome.result).toBe('CONFLICT');
    expect(await markFor()).toBeNull();
  });

  /**
   * AC2 — one budget, shared. The reaper and the error path write the same mark, so a zone that both
   * crashed and errored today has **one** row and one three-attempt allowance, not two.
   */
  it('the reaper and the error path share one mark and one budget', async () => {
    await stageAbandonedRun();
    await service.reapStaleDispatchRuns(new Date());
    const afterReap = await markFor();
    expect(afterReap!.state).toBe('PENDING');

    zoneFailure = 'and then it errored too';
    await runZone(new Date());

    expect(await prisma.dispatchZoneRecovery.count({ where: { zoneId } })).toBe(1);
    const merged = await markFor();
    expect(merged!.state).toBe('PENDING');
    expect(merged!.attempts).toBe(0);
    expect(merged!.id).toBe(afterReap!.id);
  });

  /**
   * AC2 — and the budget still ends. A zone that keeps erroring exhausts at exactly the configured
   * attempts and stops being tried, with the reason kept: #285's rail reads `last_error`.
   *
   * The interaction worth pinning is that the failing recovery run **re-marks the zone from inside the
   * collector's own attempt** — my mark write and the collector's attempt accounting touch the same
   * row. The mark write never touches `attempts`, which is what keeps the collector's
   * `attempts: seen` guard matching and the budget spending exactly once per attempt.
   */
  it('an error-marked zone exhausts on the shared budget, not a fresh one', async () => {
    const policy = { maxAttempts: 2, cutoffHourIst: 24 };
    zoneFailure = 'fails every single time';
    await runZone(new Date());

    const first = await service.recoverMarkedZones(new Date(), { policy });
    expect(first).toMatchObject({ attempted: 1, recovered: 0, exhausted: 0 });
    const afterFirst = await markFor();
    expect(afterFirst!.state).toBe('PENDING');
    expect(afterFirst!.attempts).toBe(1);

    const second = await service.recoverMarkedZones(new Date(), { policy });
    expect(second).toMatchObject({ attempted: 1, exhausted: 1 });
    const afterSecond = await markFor();
    expect(afterSecond!.state).toBe('EXHAUSTED');
    expect(afterSecond!.attempts).toBe(2);
    expect(afterSecond!.lastError).toContain('fails every single time');

    // Terminal: a further error today must not put an exhausted zone back in the queue.
    await runZone(new Date());
    expect((await markFor())!.state).toBe('EXHAUSTED');
    expect(await service.recoverMarkedZones(new Date(), { policy })).toMatchObject({ attempted: 0 });
  });

  /** AC2 — the cutoff is the same one, applied to the same rows, and it dispatches nothing. */
  it('an error-marked zone expires at the operating-day cutoff without dispatching', async () => {
    zoneFailure = 'lost the zone';
    await runZone(new Date());

    const out = await service.recoverMarkedZones(new Date(), { policy: { maxAttempts: 3, cutoffHourIst: 0 } });

    expect(out).toMatchObject({ expired: 1, attempted: 0, recovered: 0 });
    const mark = await markFor();
    expect(mark!.state).toBe('EXPIRED');
    expect(mark!.lastError).toContain('cutoff');
    expect(await prisma.dispatchRunZone.count({ where: { zoneId, status: 'DONE' } })).toBe(0);
  });
});
