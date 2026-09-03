import { istDate, istDayStartInstant } from '../src/common/ist-day';
import { PrismaService } from '../src/prisma/prisma.service';
import type { RecommenderService } from '../src/recommender/recommender.service';
import type { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { DISPATCH_JOB_NAME, readAbandonedTickGraceMs } from '../src/scheduling/dispatch-cron';
import { DispatchRunService } from '../src/scheduling/dispatch-run.service';
import { DispatchSchedulerService } from '../src/scheduling/dispatch-scheduler.service';
import { alwaysClaims } from './support/tick-claims';

/**
 * #303 (forensics RC-3) — the dispatch day survives a crash between tick claim and run admission.
 *
 * `claimTick` is `INSERT … ON CONFLICT DO NOTHING` with no TTL and no heartbeat, and the claim is
 * burned **before** `admit` writes anything durable. An instance that dies in that gap leaves a claim
 * and nothing else: the reaper and the #286 collector both key off run and claim rows that were never
 * written, and every other instance already no-oped with `TICK_CLAIMED`. At minute cadence that costs
 * one tick. For `business-dispatch` — 05:00 IST, once — it costs the whole day, silently.
 *
 * Staging the crash needs no fault injection: the wreckage IS a claim row with no run behind it, so
 * these tests write exactly that and then ask the janitor what it makes of it.
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
      weightSetRef: 'abandoned-tick-spec',
    }),
  }) as unknown as RecommenderService;

const stubDispatch = (): BatchAssignmentService =>
  ({ dispatchForZone: async () => ({ schedules: 0, batches: 0, tickets: 0 }) }) as unknown as BatchAssignmentService;

describe('#303 — a dispatch tick that died before admission does not cost the day', () => {
  let prisma: PrismaService;
  let service: DispatchRunService;
  let zoneId: bigint;
  let plantId: bigint;
  const stagedRunIds: bigint[] = [];
  const stagedWindows: Date[] = [];

  const GRACE = readAbandonedTickGraceMs();

  /** A tick claim taken `minutesAgo` ago and never followed by a run — the crash this issue is about. */
  const stageClaim = async (minutesAgo: number, now: Date): Promise<Date> => {
    const windowStart = new Date(Math.floor((now.getTime() - minutesAgo * 60_000) / 60_000) * 60_000);
    await prisma.cronTickClaim.create({
      data: { jobName: DISPATCH_JOB_NAME, windowStart, claimedBy: `dead-host/999@${NS}` },
    });
    stagedWindows.push(windowStart);
    return windowStart;
  };

  /**
   * A run that DID work this zone, started after `windowStart` — the evidence the tick got in.
   *
   * The evidence is the per-ZONE row, not the run: the janitor asks "has anything dispatched this zone
   * since the claim", which is what keeps other specs' zones (and manual single-zone runs) from
   * silencing it, and what makes it stop marking a zone the collector has already put right.
   */
  const stageAdmittedRun = async (startedAt: Date): Promise<bigint> => {
    const run = await prisma.dispatchRun.create({
      data: { trigger: 'CRON', status: 'SUCCESS', startedAt, finishedAt: startedAt, configSnapshot: {} },
    });
    await prisma.dispatchRunZone.create({
      data: { runId: run.runId, zoneId, status: 'DONE', startedAt, finishedAt: startedAt },
    });
    stagedRunIds.push(run.runId);
    return run.runId;
  };

  const marksForZone = () => prisma.dispatchZoneRecovery.findMany({ where: { zoneId } });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    zoneId = (await prisma.zone.create({ data: { name: `Z-303-${NS}` } })).zoneId;
    plantId = (await prisma.plant.create({ data: { name: `P-303-${NS}`, zoneId } })).plantId;
    service = new DispatchRunService(prisma, stubRecommender(), stubDispatch());
  });

  beforeEach(async () => {
    // The shared Postgres carries other specs' claims and marks. The claim half of the janitor's
    // predicate is fleet-wide (one claim per job window), so this file has to own that window outright
    // or its assertions would be about whatever ran before it. The evidence half is per zone, which is
    // why every assertion below is scoped to this file's own zone rather than to a fleet total.
    await prisma.cronTickClaim.deleteMany({ where: { jobName: DISPATCH_JOB_NAME } });
    await prisma.dispatchZoneRecovery.deleteMany({});
  });

  afterEach(async () => {
    await prisma.dispatchZoneRecovery.deleteMany({});
    if (stagedWindows.length > 0) {
      await prisma.cronTickClaim.deleteMany({
        where: { jobName: DISPATCH_JOB_NAME, windowStart: { in: stagedWindows } },
      });
      stagedWindows.length = 0;
    }
    if (stagedRunIds.length > 0) {
      await prisma.dispatchRunZone.deleteMany({ where: { runId: { in: stagedRunIds } } });
      await prisma.dispatchRun.deleteMany({ where: { runId: { in: stagedRunIds } } });
      stagedRunIds.length = 0;
    }
  });

  afterAll(async () => {
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  /**
   * AC1 — the crash point that used to have no janitor now has one. The evidence a tick leaves when it
   * survives is an admitted run; a claim without one, past the grace period, is a tick that died.
   */
  it('marks the zones for same-day re-dispatch when a claim never produced a run', async () => {
    const now = new Date();
    const windowStart = await stageClaim(GRACE / 60_000 + 5, now);

    const out = await service.recoverAbandonedDispatchTick(now);

    expect(out.windowStart?.toISOString()).toBe(windowStart.toISOString());
    expect(out.marked).toBeGreaterThan(0);
    // Scoped to this file's own zone: the janitor is fleet-wide by design, so the assertion has to be
    // about the zone this spec owns rather than about a total other specs also contribute to.
    const marks = await marksForZone();
    expect(marks).toHaveLength(1);
    expect(marks[0].state).toBe('PENDING');
    expect(marks[0].attempts).toBe(0);
    // No run to name — the whole point of this path is that none was ever written.
    expect(marks[0].markedByRunId).toBeNull();
    expect(marks[0].businessDate.toISOString().slice(0, 10)).toBe(istDate(now).toISOString().slice(0, 10));
  });

  it('says nothing when the tick did admit a run — a healthy day writes no marks', async () => {
    const now = new Date();
    const windowStart = await stageClaim(GRACE / 60_000 + 5, now);
    await stageAdmittedRun(new Date(windowStart.getTime() + 1_000));

    const out = await service.recoverAbandonedDispatchTick(now);

    // Zone-scoped on purpose. The janitor is fleet-wide, and the shared test database holds other
    // specs' zones which may genuinely be owed a day — so `out.marked` is not this file's to assert.
    // The invariant this case owns is that OUR zone, which has a dispatch since the claim, is not
    // among the marked.
    expect(await marksForZone()).toHaveLength(0);
    expect(out.windowStart?.toISOString()).not.toBe(undefined);
  });

  /**
   * The false positive that would matter most. #259's rule is that a run which never happened leaves no
   * history, and #260's patient tick holds its claim for up to the retry deadline while every zone is
   * contended — so "claim, no run" is the HEALTHY state for that whole window. A grace period shorter
   * than the deadline would re-dispatch zones somebody is still working.
   */
  it('leaves a claim inside the grace period alone — patience is not death', async () => {
    const now = new Date();
    await stageClaim(GRACE / 60_000 - 5, now);

    const out = await service.recoverAbandonedDispatchTick(now);

    expect(out).toEqual({ marked: 0, windowStart: null });
    expect(await marksForZone()).toHaveLength(0);
  });

  /**
   * A lost day is lost. `markZonesForRecovery` stamps `businessDate = istDate(now)`, so acting on an
   * old abandoned claim would mark TODAY's zones for a day that is long over — and the dev database
   * already holds `business-dispatch` claims from previous days, so this is not hypothetical.
   */
  it('ignores an abandoned claim from a previous operating day', async () => {
    const now = new Date();
    const yesterday = new Date(istDayStartInstant(now).getTime() - 3 * 60 * 60_000);
    await prisma.cronTickClaim.create({
      data: { jobName: DISPATCH_JOB_NAME, windowStart: yesterday, claimedBy: `dead-host/998@${NS}` },
    });
    stagedWindows.push(yesterday);

    const out = await service.recoverAbandonedDispatchTick(now);

    expect(out).toEqual({ marked: 0, windowStart: null });
    expect(await marksForZone()).toHaveLength(0);
  });

  /**
   * Self-limiting, and it has to be: the reaper tick runs every three minutes, so a janitor that
   * re-marked on every pass would keep re-arming a zone the collector had already put right.
   */
  it('goes quiet once the recovery has admitted a run, and does not re-arm a retired mark', async () => {
    const now = new Date();
    const windowStart = await stageClaim(GRACE / 60_000 + 5, now);

    await service.recoverAbandonedDispatchTick(now);
    expect(await marksForZone()).toHaveLength(1);

    // What the collector's re-dispatch leaves behind for THIS zone: a run-zone row after the window.
    await stageAdmittedRun(new Date(windowStart.getTime() + 60_000));
    await prisma.dispatchZoneRecovery.deleteMany({ where: { zoneId } });
    await service.recoverAbandonedDispatchTick(now);
    expect(await marksForZone()).toHaveLength(0);

    // And a mark the collector retired stays retired, even on a zone the janitor would otherwise
    // re-mark — `markZonesForRecovery` re-arms PENDING/RECOVERED and leaves EXHAUSTED/EXPIRED alone,
    // which is what stops a three-minute janitor from looping on a zone that cannot be recovered.
    await prisma.dispatchRunZone.deleteMany({ where: { runId: { in: stagedRunIds } } });
    await prisma.dispatchZoneRecovery.create({
      data: { zoneId, businessDate: istDate(now), state: 'EXHAUSTED', attempts: 2, markedAt: now },
    });
    await service.recoverAbandonedDispatchTick(now);
    expect((await marksForZone())[0].state).toBe('EXHAUSTED');
  });

  /** AC1 end-to-end: the janitor is actually wired into the tick that runs every three minutes. */
  it('the dispatch reaper tick runs the janitor', async () => {
    const now = new Date();
    await stageClaim(GRACE / 60_000 + 5, now);
    const scheduler = new DispatchSchedulerService(service, alwaysClaims(), { enabled: true });

    expect(await scheduler.dispatchReaperTick(now)).toEqual({ ran: true });

    expect(await marksForZone()).toHaveLength(1);
  });

  /** AC3 — no other job's claims are inspected, so no sweep's tick semantics change. */
  it('ignores every job but business-dispatch', async () => {
    const now = new Date();
    const windowStart = new Date(Math.floor((now.getTime() - GRACE - 60_000) / 60_000) * 60_000);
    await prisma.cronTickClaim.create({
      data: { jobName: 'business-verification', windowStart, claimedBy: `dead-host/997@${NS}` },
    });

    const out = await service.recoverAbandonedDispatchTick(now);

    expect(out).toEqual({ marked: 0, windowStart: null });
    await prisma.cronTickClaim.deleteMany({ where: { jobName: 'business-verification', windowStart } });
  });
});
