import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { RecommenderService } from '../src/recommender/recommender.service';
import { DispatchRunService } from '../src/scheduling/dispatch-run.service';
import { alwaysClaims } from './support/tick-claims';
import { DispatchSchedulerService } from '../src/scheduling/dispatch-scheduler.service';

/**
 * #213 slice 2 — ONE shared per-zone in-flight guard.
 *
 * The gap this closes: `inFlight` was a private field on `DispatchSchedulerService`, so it guarded only
 * the cron path, while the manual trigger called `DispatchRunService.runForActiveZones` **directly**
 * (`schedules.controller.ts:78`) and bypassed it entirely — the one path an operator reaches for during
 * an emergency was precisely the path with no concurrency guard. The operator ruling was explicit: fix
 * the root cause, do not add a second check. The guard now lives inside the shared run path, so neither
 * entry point can go around it.
 *
 * The refusal must be *clear* — naming when the in-flight run started and who started it — and
 * specifically not a queued run, a silent no-op, or a bare 409 with no body.
 *
 * Timing is real, not simulated: the recommender (which every run awaits, per zone) is blocked, so a run
 * is genuinely mid-flight when the second caller arrives. Assertions are on the two callers' outcomes
 * rather than on `dispatch_runs` row counts — a count of "runs since X" is not this spec's to claim.
 *
 * #259 — the guard these tests exercise is now the `dispatch_run_zones` claim row rather than an
 * in-process `Map`, so every case below holds across instances and restarts as well. The
 * cross-connection proofs live in `dispatch-zone-claim-admission.e2e-spec.ts`; what stays here is that
 * BOTH entry points — the cron tick and the manual HTTP trigger — go through one guard.
 */
describe('#213 slice 2 — one shared per-zone dispatch in-flight guard (e2e)', () => {
  let app: INestApplication;
  let dispatchRun: DispatchRunService;
  let scheduler: DispatchSchedulerService;

  /** Non-null while a run should hang inside the recommender; resolve it to let the run finish. */
  let block: { promise: Promise<void>; release: () => void } | null = null;
  const newBlock = () => {
    let release!: () => void;
    const promise = new Promise<void>((res) => {
      release = () => res();
    });
    return { promise, release };
  };
  /** Long enough for the first caller to reach the recommender and take the guard. */
  const letFirstCallerTakeTheGuard = () => new Promise((r) => setTimeout(r, 150));

  /** Only zone 1 hangs: a run that blocked *every* zone would also block the second caller in the
   *  per-zone test, which is the case that has to prove zone 2 is free to run. */
  const BLOCKED_ZONE = 1n;
  const stubRecommender = {
    runForZone: async (zoneId: bigint) => {
      if (block && zoneId === BLOCKED_ZONE) await block.promise;
      return { ticketsConsidered: 0, recommended: 0, unassignable: 0, mode: 'DEFICIT', weightSetRef: 'test' };
    },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RecommenderService)
      .useValue(stubRecommender)
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    dispatchRun = app.get(DispatchRunService);
    // The scheduled path, with the #108 master switch on so the tick actually runs. Shares the app's
    // DispatchRunService singleton, which is the point — the guard has to be common to both entries.
    // #260 made the cron tick patient with a contended zone. This spec is about the GUARD — that a
    // second run is never started over a first — not about how long the tick is willing to wait, so it
    // pins patience OFF (`deadlineMs: 0`, the documented try-once switch) and keeps asserting the
    // refusal it always did. The patient behaviour has its own spec,
    // `dispatch-cron-bounded-retry.e2e-spec.ts`. Passed through the config param rather than the
    // environment, per #182 R5.
    scheduler = new DispatchSchedulerService(dispatchRun, alwaysClaims(), {
      enabled: true,
      retry: { intervalMs: 60_000, deadlineMs: 0 },
    });
  });

  // A test that fails mid-block must not leave a run hanging — the guard would still be held and every
  // later test would see a phantom conflict.
  afterEach(() => {
    block?.release();
    block = null;
  });

  afterAll(async () => {
    block?.release();
    await app.close();
  });

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  };

  const manualRun = (token: string, body: Record<string, unknown>) =>
    request(app.getHttpServer()).post('/api/schedules/dispatch-run').set('Authorization', `Bearer ${token}`).send(body);

  /**
   * The operator-requested regression case, stated verbatim on #213: a scheduled run is in flight, the
   * manual trigger fires, and exactly one run executes while the caller is told why. A 409 here also
   * proves no second ledger row was opened — the guard is checked before `dispatch_runs.create`.
   */
  it('a scheduled run in flight refuses the manual trigger, and says when it started and who started it', async () => {
    const token = await login('ops.head@fsm.test');

    block = newBlock();
    const scheduled = scheduler.dispatchTick(new Date());
    await letFirstCallerTakeTheGuard();

    const refused = await manualRun(token, { zoneId: 1 }).expect(409);
    expect(refused.body.code).toBe('DISPATCH_ALREADY_RUNNING');
    expect(refused.body.message).toMatch(/dispatch already running for this zone/i);
    expect(refused.body.message).toContain('SYSTEM'); // the cron actor
    expect(refused.body.inFlight?.[0]).toMatchObject({ zoneId: '1', trigger: 'CRON', actor: 'SYSTEM' });
    expect(typeof refused.body.inFlight[0].startedAt).toBe('string');

    block.release();
    expect(await scheduled).toEqual({ ran: true }); // the ONE run that executed
    block = null;
  }, 20_000);

  it('the reverse holds: a manual run in flight makes the cron tick skip rather than start a second run', async () => {
    const token = await login('ops.head@fsm.test');

    block = newBlock();
    const manual = manualRun(token, {}).then((r) => r);
    await letFirstCallerTakeTheGuard();

    expect(await scheduler.dispatchTick(new Date())).toEqual({ ran: false, reason: 'RUN_IN_PROGRESS' });

    block.release();
    expect((await manual).status).toBe(200);
    block = null;
  }, 20_000);

  it('is per zone — a run in one zone does not refuse a manual run in another', async () => {
    const token = await login('ops.head@fsm.test');

    block = newBlock();
    const zoneOne = dispatchRun.runForActiveZones(new Date(), { zoneId: 1n });
    await letFirstCallerTakeTheGuard();

    await manualRun(token, { zoneId: 2 }).expect(200);

    block.release();
    await zoneOne;
    block = null;
  }, 20_000);

  it('releases the guard when a run finishes, so the next run is allowed', async () => {
    expect(await scheduler.dispatchTick(new Date())).toEqual({ ran: true });
    expect(await scheduler.dispatchTick(new Date())).toEqual({ ran: true });
  });

  /**
   * The classic wedge: a guard taken and never released leaves dispatch permanently refusing. Driven
   * through the real service with a ledger write that fails, so the release has to be in a `finally`.
   *
   * #259 moved the guard from a `Map` entry to a row, which makes the wedge durable rather than
   * process-lived — so the break has to land where a claim is actually open. The per-zone finalize is
   * that point: the run row is written and the zone is claimed, and the write that would close the
   * claim is the one that fails.
   */
  it('releases the guard even when the run throws, so one failure does not wedge dispatch forever', async () => {
    // #261 re-aimed this break, for the reason its own comment above already gives: it has to land on
    // the write that closes a claim, and that write is now an `updateMany` conditional on the claim
    // still being RUNNING. Breaking `updateMany` outright would also break `releaseStrandedClaims` —
    // the release this test exists to prove — so the patch discriminates on what separates them: the
    // per-zone finalize names a `zoneId`, the release does not. Patched by assignment with an explicit
    // restore rather than `vi.spyOn`, because a Prisma delegate's methods are not own properties and
    // `restoreAllMocks` deletes rather than restores them.
    type ZoneWrite = { where?: { zoneId?: bigint } };
    const prismaLike = (
      dispatchRun as unknown as { prisma: { dispatchRunZone: { updateMany: (a: ZoneWrite) => unknown } } }
    ).prisma;
    const originalUpdateMany = prismaLike.dispatchRunZone.updateMany;
    prismaLike.dispatchRunZone.updateMany = async (args: ZoneWrite) => {
      if (args.where?.zoneId != null) throw new Error('ledger write exploded');
      return originalUpdateMany.call(prismaLike.dispatchRunZone, args);
    };
    await expect(dispatchRun.runForActiveZones(new Date(), { zoneId: 1n })).rejects.toThrow('ledger write exploded');
    prismaLike.dispatchRunZone.updateMany = originalUpdateMany;

    const outcome = await dispatchRun.runForActiveZones(new Date(), { zoneId: 1n });
    expect(outcome.result).toBe('RAN');
  });

  it('exposes the in-flight state so the admin button can be disabled before anyone presses it', async () => {
    const token = await login('ops.head@fsm.test');

    block = newBlock();
    const running = dispatchRun.runForActiveZones(new Date(), {
      zoneId: 1n,
      trigger: 'MANUAL',
      actorRole: 'OPERATIONS_HEAD',
    });
    await letFirstCallerTakeTheGuard();

    const during = await request(app.getHttpServer())
      .get('/api/schedules/dispatch-run/in-flight')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(during.body.inFlight).toHaveLength(1);
    expect(during.body.inFlight[0]).toMatchObject({ zoneId: '1', trigger: 'MANUAL', actor: 'OPERATIONS_HEAD' });

    block.release();
    await running;
    block = null;

    const after = await request(app.getHttpServer())
      .get('/api/schedules/dispatch-run/in-flight')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(after.body.inFlight).toEqual([]);
  }, 20_000);
});
