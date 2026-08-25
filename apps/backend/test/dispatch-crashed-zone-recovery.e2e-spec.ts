import { istDate } from '../src/common/ist-day';
import { PrismaService } from '../src/prisma/prisma.service';
import type { RecommenderService } from '../src/recommender/recommender.service';
import type { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { DispatchRunService } from '../src/scheduling/dispatch-run.service';
import { DispatchSchedulerService } from '../src/scheduling/dispatch-scheduler.service';
import { alwaysClaims, neverClaims } from './support/tick-claims';

/**
 * #286 — a crashed zone gets its day back.
 *
 * #261 made a dead run's zone claim recoverable; it deliberately stopped there ("a reaper that
 * dispatched the zones it freed would be an unscheduled dispatch run at an arbitrary minute of the
 * day"). The consequence is the gap #282 R3 ruled on: the zone is freed and then nothing asks for it
 * until 05:00 tomorrow, so a crash at 05:02 costs that zone its entire field day.
 *
 * The reaper still does not dispatch. It **marks**, in the database (Q8 — process death must not lose
 * the fact), and a bounded collector re-dispatches marked zones through the ordinary admission path.
 */
const NS = Date.now();

/** Set to a message to make the next zone's recommender blow up; cleared after every test. */
let zoneFailure: string | null = null;
/** Set to park a run inside the recommender, so a zone can be held while something else asks for it. */
let park: { promise: Promise<void>; release: () => void } | null = null;

const newPark = (): { promise: Promise<void>; release: () => void } => {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = () => r()));
  return { promise, release };
};

const stubRecommender = (): RecommenderService =>
  ({
    runForZone: async () => {
      if (zoneFailure) throw new Error(zoneFailure);
      if (park) await park.promise;
      return {
        ticketsConsidered: 0,
        recommended: 0,
        unassignable: 0,
        withheldBelowThreshold: 0,
        bucketlessDropped: 0,
        componentBlockedWithheld: 0,
        assignmentThresholdHours: null,
        mode: 'DEFICIT',
        weightSetRef: 'recovery-spec',
      };
    },
  }) as unknown as RecommenderService;

const stubDispatch = (): BatchAssignmentService =>
  ({ dispatchForZone: async () => ({ schedules: 0, batches: 0, tickets: 0 }) }) as unknown as BatchAssignmentService;

describe('#286 — crashed-zone same-day bounded re-dispatch (e2e)', () => {
  let prisma: PrismaService;
  let service: DispatchRunService;
  /** The second connection pool + service — see `beforeAll`. */
  let prismaOther: PrismaService;
  let other: DispatchRunService;
  let zoneId: bigint;
  let plantId: bigint;
  const stagedRunIds: bigint[] = [];

  const HOUR_AGO = (): Date => new Date(Date.now() - 60 * 60 * 1000);

  /** The wreckage a killed process leaves: a RUNNING run with a RUNNING claim and nobody alive. */
  const stageAbandonedRun = async (heartbeatAt: Date | null = HOUR_AGO()): Promise<bigint> => {
    const startedAt = HOUR_AGO();
    const run = await prisma.dispatchRun.create({
      data: { trigger: 'CRON', status: 'RUNNING', startedAt, heartbeatAt, configSnapshot: {} },
    });
    await prisma.dispatchRunZone.create({ data: { runId: run.runId, zoneId, status: 'RUNNING', startedAt } });
    stagedRunIds.push(run.runId);
    return run.runId;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    // A SECOND pool and a second service — "the other process", as closely as one test file can stage
    // it. AC7 is about two admissions that cannot see each other's memory, so a test that drove one
    // singleton twice would prove nothing (the same reasoning `dispatch-zone-claim-admission` gives).
    prismaOther = new PrismaService();
    await prismaOther.onModuleInit();
    zoneId = (await prisma.zone.create({ data: { name: `Z-recover-${NS}` } })).zoneId;
    plantId = (await prisma.plant.create({ data: { name: `P-recover-${NS}`, zoneId } })).plantId;
    service = new DispatchRunService(prisma, stubRecommender(), stubDispatch());
    other = new DispatchRunService(prismaOther, stubRecommender(), stubDispatch());
  });

  beforeEach(async () => {
    // One Postgres is shared by the whole suite and other specs leave abandoned claims behind. Draining
    // them here — and clearing the marks that drain produces — is what makes "the reap in this test
    // produced exactly one mark" true of this zone rather than of whatever ran before it.
    await service.reapStaleDispatchRuns(new Date());
    await prisma.dispatchZoneRecovery.deleteMany({});
  });

  afterEach(async () => {
    // A test that fails while a run is parked would hang every later test behind its claim.
    park?.release();
    park = null;
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
    await prismaOther.onModuleDestroy();
    await prisma.onModuleDestroy();
  });

  /**
   * The first half of the mechanism, and the half that has to survive a second crash: the reaper does
   * not dispatch, it leaves behind a **row** saying this zone owes a day. Memory would be lost with the
   * process that noticed — the same process death the reaper exists to clean up after.
   */
  it('reaping a dead run leaves a PENDING same-day recovery mark for the zone it held', async () => {
    const now = new Date();
    const deadRunId = await stageAbandonedRun();

    await service.reapStaleDispatchRuns(now);

    const mark = await prisma.dispatchZoneRecovery.findFirstOrThrow({ where: { zoneId } });
    expect(mark.state).toBe('PENDING');
    expect(mark.attempts).toBe(0);
    expect(mark.markedByRunId).toBe(deadRunId);
    expect(mark.businessDate.toISOString().slice(0, 10)).toBe(istDate(now).toISOString().slice(0, 10));
  });

  /**
   * AC1 — the point of the whole issue. Before this the zone was freed and then nobody asked for it
   * until 05:00 tomorrow.
   *
   * The assertion that matters is not the counter: it is the DONE claim row. A collector that
   * dispatched by some private route would satisfy "the zone ran" while bypassing the tick claim, the
   * per-zone claim and the per-SE transactions that G1-G8 are made of. A claim row on a real
   * `dispatch_runs` row is the evidence that it went through admission like everything else.
   */
  it('the collector re-dispatches a marked zone the same day, through the ordinary admission path', async () => {
    const deadRunId = await stageAbandonedRun();
    await service.reapStaleDispatchRuns(new Date());

    const outcome = await service.recoverMarkedZones(new Date());

    expect(outcome.recovered).toBe(1);
    const mark = await prisma.dispatchZoneRecovery.findFirstOrThrow({ where: { zoneId } });
    expect(mark.state).toBe('RECOVERED');
    expect(mark.attempts).toBe(1);
    expect(mark.resolvedAt).not.toBeNull();

    const claim = await prisma.dispatchRunZone.findFirstOrThrow({ where: { zoneId, status: 'DONE' } });
    expect(claim.runId).not.toBe(deadRunId);
    const run = await prisma.dispatchRun.findUniqueOrThrow({ where: { runId: claim.runId } });
    expect(run.status).toBe('SUCCESS');
  });

  /**
   * AC5 — the half that makes automatic recovery safe to switch on.
   *
   * A collector with no budget is a retry loop, and a retry loop against a zone that fails
   * deterministically is a machine for filling the ledger with identical failures until somebody
   * notices. The bound has to end in a *recorded* state, not in silence: EXHAUSTED with the last
   * failure on it is what #285's rail reads.
   */
  it('stops after the attempt budget: EXHAUSTED, with the reason kept, and nothing tried again today', async () => {
    const policy = { maxAttempts: 2, cutoffHourIst: 24 };
    await stageAbandonedRun();
    await service.reapStaleDispatchRuns(new Date());
    zoneFailure = `zone ${zoneId} keeps failing`;

    const first = await service.recoverMarkedZones(new Date(), { policy });
    expect(first).toMatchObject({ attempted: 1, recovered: 0, exhausted: 0 });
    const afterFirst = await prisma.dispatchZoneRecovery.findFirstOrThrow({ where: { zoneId } });
    expect(afterFirst.state).toBe('PENDING');
    expect(afterFirst.attempts).toBe(1);

    const second = await service.recoverMarkedZones(new Date(), { policy });
    expect(second).toMatchObject({ attempted: 1, exhausted: 1 });
    const afterSecond = await prisma.dispatchZoneRecovery.findFirstOrThrow({ where: { zoneId } });
    expect(afterSecond.state).toBe('EXHAUSTED');
    expect(afterSecond.attempts).toBe(2);
    expect(afterSecond.lastError).toContain('keeps failing');

    // The bound is on the zone's day, not on one pass: a third collector tick must find nothing to do.
    const third = await service.recoverMarkedZones(new Date(), { policy });
    expect(third).toEqual({ attempted: 0, recovered: 0, exhausted: 0, expired: 0, deferred: 0 });
    expect((await prisma.dispatchZoneRecovery.findFirstOrThrow({ where: { zoneId } })).attempts).toBe(2);
  });

  /**
   * The same bound, seen from the other side: a zone that crashes a second time after being put right
   * draws from the SAME day's budget. Re-arming with a fresh budget on every crash would make
   * "bounded" a property of each incident, and a zone whose every run dies would loop all day.
   */
  it('a second crash re-arms a RECOVERED zone but does not refill its budget', async () => {
    const policy = { maxAttempts: 2, cutoffHourIst: 24 };
    await stageAbandonedRun();
    await service.reapStaleDispatchRuns(new Date());
    await service.recoverMarkedZones(new Date(), { policy });
    expect((await prisma.dispatchZoneRecovery.findFirstOrThrow({ where: { zoneId } })).state).toBe('RECOVERED');

    await stageAbandonedRun();
    await service.reapStaleDispatchRuns(new Date());

    const reArmed = await prisma.dispatchZoneRecovery.findFirstOrThrow({ where: { zoneId } });
    expect(reArmed.state).toBe('PENDING');
    expect(reArmed.attempts).toBe(1); // carried over, not reset
    expect(reArmed.resolvedAt).toBeNull();

    zoneFailure = 'second crash, and it fails';
    await service.recoverMarkedZones(new Date(), { policy });
    const spent = await prisma.dispatchZoneRecovery.findFirstOrThrow({ where: { zoneId } });
    expect(spent.state).toBe('EXHAUSTED');
    expect(spent.attempts).toBe(2);
  });

  /**
   * And an EXHAUSTED zone stays exhausted. A crash arriving after the budget is spent must not put the
   * zone back in the queue — that is the loop the budget exists to prevent, reached by a different door.
   */
  it('a crash after the budget is spent does not re-arm the zone', async () => {
    const policy = { maxAttempts: 1, cutoffHourIst: 24 };
    await stageAbandonedRun();
    await service.reapStaleDispatchRuns(new Date());
    zoneFailure = 'fails every time';
    await service.recoverMarkedZones(new Date(), { policy });
    expect((await prisma.dispatchZoneRecovery.findFirstOrThrow({ where: { zoneId } })).state).toBe('EXHAUSTED');

    zoneFailure = null;
    await stageAbandonedRun();
    await service.reapStaleDispatchRuns(new Date());

    const still = await prisma.dispatchZoneRecovery.findFirstOrThrow({ where: { zoneId } });
    expect(still.state).toBe('EXHAUSTED');
    expect(await service.recoverMarkedZones(new Date(), { policy })).toMatchObject({ attempted: 0 });
  });

  /**
   * The other bound. A day plan produced at 19:00 is not a recovered field day — it is work nobody will
   * do, and #258 Q6's ordinal-only plan cannot say "tomorrow morning" either. EXPIRED is a recorded
   * outcome for the same reason EXHAUSTED is: the operator has to be able to see the day that was lost.
   */
  it('expires outstanding marks once the operating-day cutoff has passed, without dispatching', async () => {
    await stageAbandonedRun();
    await service.reapStaleDispatchRuns(new Date());

    const outcome = await service.recoverMarkedZones(new Date(), { policy: { maxAttempts: 3, cutoffHourIst: 0 } });

    expect(outcome).toMatchObject({ expired: 1, attempted: 0, recovered: 0 });
    const mark = await prisma.dispatchZoneRecovery.findFirstOrThrow({ where: { zoneId } });
    expect(mark.state).toBe('EXPIRED');
    expect(mark.attempts).toBe(0);
    expect(mark.lastError).toContain('cutoff');
    expect(await prisma.dispatchRunZone.count({ where: { zoneId, status: 'DONE' } })).toBe(0);
  });

  /**
   * The production entry point. `recoverMarkedZones` being right is worth nothing if nothing calls it,
   * and the two gates it has to wear are the ones every other tick in this app wears: the #108 master
   * switch, re-read every tick, and #263's tick claim — without which two enabled instances would both
   * collect the same marks and race each other's admissions.
   */
  describe('the collector tick', () => {
    it('is a dormant no-op while the master switch is off', async () => {
      await stageAbandonedRun();
      await service.reapStaleDispatchRuns(new Date());

      const off = new DispatchSchedulerService(service, alwaysClaims(), { enabled: false });
      expect(await off.dispatchRecoveryTick(new Date())).toEqual({ ran: false, reason: 'DISABLED' });
      expect((await prisma.dispatchZoneRecovery.findFirstOrThrow({ where: { zoneId } })).state).toBe('PENDING');
    });

    it('stands down when another instance holds the window', async () => {
      await stageAbandonedRun();
      await service.reapStaleDispatchRuns(new Date());

      const contended = new DispatchSchedulerService(service, neverClaims(), { enabled: true });
      expect(await contended.dispatchRecoveryTick(new Date())).toEqual({ ran: false, reason: 'TICK_CLAIMED' });
      expect((await prisma.dispatchZoneRecovery.findFirstOrThrow({ where: { zoneId } })).state).toBe('PENDING');
    });

    it('recovers the marked zone when enabled and unclaimed', async () => {
      await stageAbandonedRun();
      await service.reapStaleDispatchRuns(new Date());

      const on = new DispatchSchedulerService(service, alwaysClaims(), { enabled: true });
      expect(await on.dispatchRecoveryTick(new Date())).toEqual({ ran: true });
      expect((await prisma.dispatchZoneRecovery.findFirstOrThrow({ where: { zoneId } })).state).toBe('RECOVERED');
    });

    /** A tick that throws out of the cron context takes the process's scheduler with it (#108's posture). */
    it('contains a failure rather than throwing out of the cron context', async () => {
      const exploding = {
        recoverMarkedZones: async () => {
          throw new Error('collector blew up');
        },
      } as unknown as DispatchRunService;
      const on = new DispatchSchedulerService(exploding, alwaysClaims(), { enabled: true });
      expect(await on.dispatchRecoveryTick(new Date())).toEqual({ ran: false, reason: 'ERROR' });
    });
  });

  /**
   * AC7 + AC6 — the collector is one more caller of admission, with no privileges.
   *
   * Asserted across two pools, because the property is that a *second process* cannot get in. What
   * arbitrates is `ux_dispatch_run_zones_one_running_per_zone` (#259), which the collector reaches by
   * going through `runForActiveZones` like everybody else; these tests exist to pin that it really does
   * go through it, rather than growing a private route that quietly bypasses the claim.
   */
  describe('against a live run on another connection', () => {
    it('defers to whoever holds the zone and does not spend an attempt on being busy', async () => {
      await stageAbandonedRun();
      await service.reapStaleDispatchRuns(new Date());

      // A run on the other connection takes the zone and stays inside it.
      park = newPark();
      const held = other.runForActiveZones(new Date(), { zoneId, trigger: 'MANUAL', reason: `hold-${NS}` });
      await new Promise((r) => setTimeout(r, 150));

      const out = await service.recoverMarkedZones(new Date(), { policy: { maxAttempts: 2, cutoffHourIst: 24 } });

      expect(out).toMatchObject({ deferred: 1, attempted: 0, recovered: 0 });
      // Still owed, and its budget is intact: being busy is not being broken.
      const mark = await prisma.dispatchZoneRecovery.findFirstOrThrow({ where: { zoneId } });
      expect(mark.state).toBe('PENDING');
      expect(mark.attempts).toBe(0);

      park.release();
      park = null;
      expect((await held).result).toBe('RAN');

      // And once the holder is gone, the very next pass recovers it.
      const after = await service.recoverMarkedZones(new Date(), { policy: { maxAttempts: 2, cutoffHourIst: 24 } });
      expect(after).toMatchObject({ recovered: 1 });
    });

    /**
     * AC6 — the manual button is not consumed by any of this. It is still never patient (an operator
     * gets an answer, not a queue), it still names the holder in its refusal, and an outstanding
     * recovery mark neither blocks it nor is silently spent by it.
     */
    it('a manual run is refused immediately and by name, and the recovery mark is untouched', async () => {
      await stageAbandonedRun();
      await service.reapStaleDispatchRuns(new Date());

      park = newPark();
      const held = other.runForActiveZones(new Date(), { zoneId, trigger: 'CRON', retry: { intervalMs: 0, deadlineMs: 0 } });
      await new Promise((r) => setTimeout(r, 150));

      const startedAt = Date.now();
      const manual = await service.runForActiveZones(new Date(), { zoneId, trigger: 'MANUAL', reason: `manual-${NS}` });

      expect(manual.result).toBe('CONFLICT');
      if (manual.result !== 'CONFLICT') return;
      // Immediately: a MANUAL run never waits, whatever the retry policy says.
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(manual.inFlight).toHaveLength(1);
      expect(manual.inFlight[0].zoneId).toBe(zoneId.toString());
      expect(manual.inFlight[0].runId).not.toBeUndefined();

      const mark = await prisma.dispatchZoneRecovery.findFirstOrThrow({ where: { zoneId } });
      expect(mark.state).toBe('PENDING');
      expect(mark.attempts).toBe(0);

      park.release();
      park = null;
      expect((await held).result).toBe('RAN');
    });
  });
});
