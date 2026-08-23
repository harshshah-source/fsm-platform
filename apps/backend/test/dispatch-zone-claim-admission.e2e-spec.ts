import { PrismaService } from '../src/prisma/prisma.service';
import type { RecommenderService } from '../src/recommender/recommender.service';
import type { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { DispatchRunService } from '../src/scheduling/dispatch-run.service';
import { DispatchTransparencyQueryService } from '../src/scheduling/dispatch-transparency-query.service';
import { createBarrier, expectExactlyOneWinner } from './support/concurrency';

/**
 * #259 — run admission is **database-authoritative and per-zone**.
 *
 * The guard #213 installed was an in-process `Map` on the `DispatchRunService` singleton. That gives
 * an operator a clear answer when they press the button twice *in one process*, and nothing at all
 * when the second caller is a second instance or the same instance after a restart: the map dies with
 * the process and is invisible across connections. This spec pins the replacement — the claim is a
 * `dispatch_run_zones` row opened at admission, so a refusal survives the process that issued it.
 *
 * Every assertion here is made across **two independently constructed services over two separate
 * `PrismaService` connection pools**. That is the whole point: a test that drove one singleton twice
 * would pass against the map and prove nothing about the property the issue asks for.
 */
const NS = Date.now();

/** Resolves when released — the handle that keeps a run genuinely mid-flight while we probe it. */
const newBlock = (zone: bigint): { zone: bigint; promise: Promise<void>; release: () => void } => {
  let release!: () => void;
  const promise = new Promise<void>((res) => {
    release = () => res();
  });
  return { zone, promise, release };
};

/** A recommender that reports nothing and optionally hangs, so a run can be parked inside a zone. */
const stubRecommender = (block: (zoneId: bigint) => Promise<void> | null): RecommenderService =>
  ({
    runForZone: async (zoneId: bigint) => {
      const held = block(zoneId);
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
        weightSetRef: 'claim-spec',
      };
    },
  }) as unknown as RecommenderService;

const stubDispatch = (): BatchAssignmentService =>
  ({
    dispatchForZone: async () => ({ schedules: 0, batches: 0, tickets: 0 }),
  }) as unknown as BatchAssignmentService;

describe('#259 — DB-backed per-zone dispatch claims (e2e)', () => {
  /** Two pools, two services — "another process" as closely as one test file can stage it. */
  let prismaA: PrismaService;
  let prismaB: PrismaService;
  let serviceA: DispatchRunService;
  let serviceB: DispatchRunService;

  let zoneId: bigint;
  let zoneIdB: bigint;
  let plantId: bigint;
  let plantIdB: bigint;

  /**
   * The parked zone, shared by BOTH services. Zone-scoped so a test can hold one zone open while the
   * other service works freely on another — and so a race for the *same* zone can park whichever
   * caller wins it, which is what makes the loser's collision deterministic instead of timing-dependent.
   */
  let block: { zone: bigint; promise: Promise<void>; release: () => void } | null = null;
  /** Synthetic holder runs staged by {@link holdZone}, torn down after every test. */
  const holderRunIds: bigint[] = [];

  beforeAll(async () => {
    prismaA = new PrismaService();
    await prismaA.onModuleInit();
    prismaB = new PrismaService();
    await prismaB.onModuleInit();

    zoneId = (await prismaA.zone.create({ data: { name: `Z-claim-${NS}` } })).zoneId;
    plantId = (await prismaA.plant.create({ data: { name: `P-claim-${NS}`, zoneId } })).plantId;
    zoneIdB = (await prismaA.zone.create({ data: { name: `Z-claim-b-${NS}` } })).zoneId;
    plantIdB = (await prismaA.plant.create({ data: { name: `P-claim-b-${NS}`, zoneId: zoneIdB } })).plantId;

    const parked = (z: bigint) => (block !== null && block.zone === z ? block.promise : null);
    serviceA = new DispatchRunService(prismaA, stubRecommender(parked), stubDispatch());
    serviceB = new DispatchRunService(prismaB, stubRecommender(parked), stubDispatch());
  });

  afterEach(async () => {
    // A test that fails mid-block must not leave a run parked: its claim would still be held and every
    // later test in the file would see a phantom conflict.
    block?.release();
    block = null;
    await releaseHolders();
  });

  afterAll(async () => {
    block?.release();
    await releaseHolders();
    const mine = { zoneId: { in: [zoneId, zoneIdB] } };
    const runIds = (await prismaA.dispatchRunZone.findMany({ where: mine, select: { runId: true } })).map((r) => r.runId);
    await prismaA.dispatchRunZone.deleteMany({ where: mine });
    await prismaA.dispatchRun.deleteMany({ where: { runId: { in: runIds } } });
    await prismaA.plant.deleteMany({ where: { plantId: { in: [plantId, plantIdB] } } });
    await prismaA.zone.deleteMany({ where: { zoneId: { in: [zoneId, zoneIdB] } } });
    await prismaA.onModuleDestroy();
    await prismaB.onModuleDestroy();
  });

  /** Long enough for the first caller to open its claim and reach the parked recommender. */
  const letTheClaimSettle = () => new Promise((r) => setTimeout(r, 150));

  /**
   * Stage a live claim the way another process would leave one: a real `dispatch_runs` row with a
   * RUNNING `dispatch_run_zones` row under it, written over the second pool. Returns the run id so a
   * refusal can be checked against the holder it names.
   */
  const holdZone = async (zone: bigint, actorRole: string | null): Promise<bigint> => {
    const run = await prismaB.dispatchRun.create({
      data: { trigger: 'MANUAL', actorRole, startedAt: new Date(), configSnapshot: {} },
    });
    await prismaB.dispatchRunZone.create({
      data: { runId: run.runId, zoneId: zone, status: 'RUNNING', startedAt: new Date() },
    });
    holderRunIds.push(run.runId);
    return run.runId;
  };

  /** Drop every staged claim. A leaked one would refuse the next test in the file, not just this one. */
  const releaseHolders = async (): Promise<void> => {
    if (holderRunIds.length === 0) return;
    await prismaB.dispatchRun.deleteMany({ where: { runId: { in: holderRunIds } } }); // cascades its zone rows
    holderRunIds.length = 0;
  };

  /** The same set an unscoped run walks: zones with at least one plant. */
  const activeZones = async (): Promise<bigint[]> =>
    (
      await prismaA.plant.findMany({ distinct: ['zoneId'], select: { zoneId: true }, orderBy: { zoneId: 'asc' } })
    ).map((r) => r.zoneId);

  /** How many rows this spec's zones carry, and whether the marked request opened a run at all. */
  const ledgerCounts = async (marker: string): Promise<{ zoneRows: number; runs: number }> => ({
    zoneRows: await prismaA.dispatchRunZone.count({ where: { zoneId: { in: [zoneId, zoneIdB] } } }),
    // A `dispatch_runs` row carries no zone, so it is counted by the operator note the refused request
    // sent — precise, and safe while the suite runs spec files in parallel against one database.
    runs: await prismaA.dispatchRun.count({ where: { reason: marker } }),
  });

  /**
   * AC-1 — the claim is held by a *different connection*, which is exactly the case the in-process map
   * could not see. Service B has never heard of service A; the only thing standing between B and a
   * second concurrent run on the same zone is the row A wrote.
   */
  it('refuses a run whose zone is claimed by a different connection, and names the holder', async () => {
    block = newBlock(zoneId);
    const runningOnA = serviceA.runForActiveZones(new Date(), {
      zoneId,
      trigger: 'MANUAL',
      actorRole: 'OPERATIONS_HEAD',
    });
    await letTheClaimSettle();

    const refused = await serviceB.runForActiveZones(new Date(), { zoneId, trigger: 'MANUAL', actorRole: 'CENTRAL_SERVICE_MANAGER' });

    expect(refused.result).toBe('CONFLICT');
    if (refused.result !== 'CONFLICT') throw new Error('expected the second connection to be refused');
    expect(refused.inFlight).toHaveLength(1);
    expect(refused.inFlight[0]).toMatchObject({
      zoneId: zoneId.toString(),
      trigger: 'MANUAL',
      actor: 'OPERATIONS_HEAD',
    });
    expect(typeof refused.inFlight[0].startedAt).toBe('string');

    block.release();
    expect((await runningOnA).result).toBe('RAN');
    block = null;
  }, 30_000);

  /**
   * AC-5 — the all-held case leaves **no trace**. #213's rule is that a run which never happened has no
   * history, and a `dispatch_run_zones` row cannot exist without a parent `dispatch_runs` row, so
   * "record the refusal" and "write nothing" are the same decision. Asserted by counting rows either
   * side of the call, because "no error was thrown" would pass against an implementation that opened a
   * run row and finalized it empty.
   */
  it('writes zero rows to dispatch_runs AND dispatch_run_zones when every requested zone is held', async () => {
    const marker = `all-held-${NS}`;
    const holderRunId = await holdZone(zoneId, 'OPERATIONS_HEAD');
    const before = await ledgerCounts(marker);

    const refused = await serviceA.runForActiveZones(new Date(), { zoneId, trigger: 'MANUAL', reason: marker });

    expect(refused.result).toBe('CONFLICT');
    if (refused.result !== 'CONFLICT') throw new Error('expected a refusal');
    expect(refused.inFlight[0]).toMatchObject({ zoneId: zoneId.toString(), runId: holderRunId.toString() });
    expect(await ledgerCounts(marker)).toEqual(before);
  }, 30_000);

  /**
   * The same guarantee at the scale the cron actually asks at: an unscoped run wants every active zone,
   * and here every one of them is held. One free zone would make this a partial run; none makes it the
   * no-trace refusal, and the boundary between the two is the whole of item 4 on the issue.
   */
  it('writes zero rows when an unscoped run finds every active zone held', async () => {
    const marker = `all-held-multi-${NS}`;
    const active = await activeZones();
    expect(active.length).toBeGreaterThan(1); // otherwise this is just the single-zone case again
    for (const zone of active) await holdZone(zone, zone === zoneIdB ? null : 'OPERATIONS_HEAD');
    const before = await ledgerCounts(marker);

    const refused = await serviceA.runForActiveZones(new Date(), { trigger: 'MANUAL', reason: marker });

    expect(refused.result).toBe('CONFLICT');
    if (refused.result !== 'CONFLICT') throw new Error('expected a refusal');
    expect(refused.inFlight.map((f) => f.zoneId).sort()).toEqual(active.map((z) => z.toString()).sort());
    // The cron actor has no `actor_role` on the ledger; the operator-facing word for that is SYSTEM.
    expect(refused.inFlight.find((f) => f.zoneId === zoneIdB.toString())?.actor).toBe('SYSTEM');
    expect(await ledgerCounts(marker)).toEqual(before);
  }, 60_000);

  /**
   * AC-2 + AC-6 — the partial outcome, which is the whole reason the global refusal had to go. One
   * zone-scoped rebalance in flight at 05:00 used to cancel the entire national cron run; now it costs
   * exactly the zone it holds.
   *
   * Asserted on the run's OWN zone rows rather than on a whole-table count: an unscoped run legitimately
   * touches every zone in the database, and the claim being tested is about this run's ledger.
   */
  it('dispatches every free zone, records the held one CONTENDED, and finalizes PARTIAL', async () => {
    const marker = `partial-${NS}`;
    const holderRunId = await holdZone(zoneId, 'OPERATIONS_HEAD');

    const outcome = await serviceA.runForActiveZones(new Date(), { trigger: 'MANUAL', reason: marker });

    expect(outcome.result).toBe('RAN');
    if (outcome.result !== 'RAN') throw new Error('a run with a free zone must not be refused');
    const runId = BigInt(outcome.summary.runId);

    // Exactly one dispatch_runs row for this request — the refused zone did not spawn a second.
    expect(await prismaA.dispatchRun.count({ where: { reason: marker } })).toBe(1);

    const rows = await prismaA.dispatchRunZone.findMany({ where: { runId }, orderBy: { zoneId: 'asc' } });
    const held = rows.find((r) => r.zoneId === zoneId);
    expect(held).toMatchObject({ status: 'CONTENDED', contendedWithRunId: holderRunId, error: null });
    expect(held?.finishedAt).not.toBeNull(); // a refusal is instantaneous, never a live-looking claim
    expect(rows.filter((r) => r.zoneId !== zoneId).every((r) => r.status === 'DONE')).toBe(true);
    expect(rows.filter((r) => r.status === 'DONE').length).toBeGreaterThan(0);

    const run = await prismaA.dispatchRun.findUniqueOrThrow({ where: { runId } });
    expect(run.status).toBe('PARTIAL');
    // #123's invariant survives the new cardinality: the CONTENDED row contributes zeros, so the run's
    // columns still equal the sum of its per-zone cards.
    expect(run.zones).toBe(rows.filter((r) => r.status === 'DONE').length);
    expect(run.ticketsDispatched).toBe(rows.reduce((n, r) => n + r.ticketsDispatched, 0));
    expect(run.schedules).toBe(rows.reduce((n, r) => n + r.schedules, 0));

    // The caller is told, per zone, which zones it did not get — the run-level `zones` count cannot say.
    expect(outcome.summary.zoneOutcomes.find((z) => z.zoneId === zoneId.toString())).toMatchObject({
      outcome: 'CONTENDED',
      holder: { runId: holderRunId.toString(), actor: 'OPERATIONS_HEAD' },
    });
    expect(outcome.summary.zoneOutcomes.filter((z) => z.outcome === 'DONE').length).toBe(run.zones);

    // And the transparency read says so on the zone card, which is the surface an operator actually
    // opens. Without an outcome the card would render a zone that was refused as one that dispatched
    // nothing — the same picture as a zone with no work, which is a very different fact.
    const detail = await new DispatchTransparencyQueryService(prismaA).getRunDetail(runId, {
      role: 'OPERATIONS_HEAD',
      zoneId: null,
    });
    expect(detail?.zones.find((z) => z.zoneId === zoneId.toString())).toMatchObject({
      outcome: 'CONTENDED',
      contendedWithRunId: holderRunId.toString(),
    });
    expect(detail?.zones.find((z) => z.zoneId === zoneIdB.toString())).toMatchObject({
      outcome: 'DONE',
      contendedWithRunId: null,
    });
    // The refusal is not an error: an operator scanning the Errors column must not be sent to look for
    // a fault that never happened.
    expect(detail?.errorCount ?? 0).toBe(0);

    // The ZM whose zone was refused sees the run, and sees that it did nothing for them. `zones: 1`
    // here would claim their zone was processed, which is the opposite of what happened — and it is the
    // reading the list falls into now that a refused zone has a row at all.
    const zmRows = await new DispatchTransparencyQueryService(prismaA).listRuns({
      role: 'ZONAL_MANAGER',
      zoneId: Number(zoneId),
    });
    const mine = zmRows.find((r) => r.runId === outcome.summary.runId);
    expect(mine).toMatchObject({ zones: 0, errorCount: 0, ticketsDispatched: 0 });
  }, 60_000);

  /**
   * AC-3 — disjoint zones do not see each other at all. Proven while the first run is still parked:
   * the second one is asserted to have completed *and* the first to be visibly unfinished, so a
   * serialization that quietly made them take turns would not pass.
   */
  it('runs two zone-scoped runs on disjoint zones concurrently, two ledger rows, no interference', async () => {
    const markerA = `disjoint-a-${NS}`;
    block = newBlock(zoneId);
    const parkedOnA = serviceA.runForActiveZones(new Date(), { zoneId, trigger: 'MANUAL', reason: markerA });
    await letTheClaimSettle();

    const other = await serviceB.runForActiveZones(new Date(), { zoneId: zoneIdB, trigger: 'CRON' });
    expect(other.result).toBe('RAN');
    if (other.result !== 'RAN') throw new Error('a free zone must not be refused by a run on another zone');

    // Zone B finished while zone A is demonstrably still holding its claim — genuine overlap.
    const heldByA = await prismaA.dispatchRunZone.findFirstOrThrow({ where: { zoneId, status: 'RUNNING' } });
    const runIdB = BigInt(other.summary.runId);
    expect(heldByA.runId).not.toBe(runIdB);
    const rowsB = await prismaA.dispatchRunZone.findMany({ where: { runId: runIdB } });
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0]).toMatchObject({ zoneId: zoneIdB, status: 'DONE' });
    expect(await prismaA.dispatchRun.findUniqueOrThrow({ where: { runId: runIdB } })).toMatchObject({
      status: 'SUCCESS',
    });

    block.release();
    const finishedA = await parkedOnA;
    expect(finishedA.result).toBe('RAN');
    if (finishedA.result !== 'RAN') throw new Error('the parked run should have completed');
    expect(BigInt(finishedA.summary.runId)).not.toBe(runIdB);
    expect(await prismaA.dispatchRun.count({ where: { reason: markerA } })).toBe(1);
    block = null;
  }, 60_000);

  /**
   * AC-4 — a claim outlives the process that took it. The service instance built here has never run
   * anything and shares no memory with whoever wrote the row; the only reason it can report the zone as
   * busy is that the claim is in the database. (Releasing it is #261's reaper, deliberately not here.)
   */
  it('still reports a RUNNING claim from a service instance that never saw it taken', async () => {
    const holderRunId = await holdZone(zoneId, 'CENTRAL_SERVICE_MANAGER');

    const restarted = new DispatchRunService(prismaA, stubRecommender(() => null), stubDispatch());
    const inFlight = await restarted.inFlightZones();

    expect(inFlight.find((f) => f.zoneId === zoneId.toString())).toMatchObject({
      runId: holderRunId.toString(),
      trigger: 'MANUAL',
      actor: 'CENTRAL_SERVICE_MANAGER',
    });
  }, 30_000);

  /**
   * The race the pre-read alone cannot decide: two callers that have both *already* checked and both
   * found the zone free. Barriered rather than started-together — #107's `test/support/concurrency.ts`
   * documents why `Promise.all([f(), g()])` proves nothing here, and #265 shipped an AC that passed
   * immediately for exactly that reason.
   *
   * Two things make the overlap real rather than hoped for:
   *  - the **barrier** is installed on a collaborator the run already calls between its free-check and
   *    its first write (`captureConfigSnapshot`'s reads), which opens precisely the read→write gap
   *    without adding a seam to production code for a test's benefit;
   *  - the zone is **parked**, so whichever caller wins the claim holds it while the other one tries.
   *    Without that, a winner whose whole run is stubbed can finish and release the zone before the
   *    loser reaches its insert — and then both legitimately succeed, having never actually raced. That
   *    is not hypothetical: this test was written without the park and reported two winners.
   *
   * Which caller wins is still not decided by the test, and nothing below depends on it.
   */
  it('lets exactly one of two callers that both saw the zone free take it, and tells the other who won', async () => {
    block = newBlock(zoneId);
    const { arrive } = createBarrier(2);
    // Patched by assignment, not `vi.spyOn`: a Prisma delegate's methods are not own properties, so
    // `restoreAllMocks` deletes the spy and leaves nothing behind — which silently breaks the client
    // for every later test in the file.
    const park = (p: PrismaService): (() => void) => {
      const delegate = p.companyTierOverride;
      const original = delegate.findMany;
      type FindMany = typeof original;
      (delegate as { findMany: FindMany }).findMany = (async (...args: Parameters<FindMany>) => {
        await arrive();
        return (original as FindMany).apply(delegate, args);
      }) as FindMany;
      return () => {
        (delegate as { findMany: FindMany }).findMany = original;
      };
    };
    const restore = [park(prismaA), park(prismaB)];

    const settle = async (svc: DispatchRunService, reason: string) => {
      try {
        return {
          ok: true as const,
          value: await svc.runForActiveZones(new Date(), { zoneId, trigger: 'MANUAL', reason }),
        };
      } catch (error) {
        void arrive(); // a party that dies before arriving would hang its partner for ever
        return { ok: false as const, error };
      }
    };
    const raced = Promise.all([settle(serviceA, `race-a-${NS}`), settle(serviceB, `race-b-${NS}`)]);

    // The loser is refused without ever reaching the recommender, so it settles while the winner is
    // still parked. Releasing only then keeps the collision a certainty.
    const loserSettled = await Promise.race([
      raced.then(() => 'both' as const),
      new Promise<'one'>((r) => setTimeout(() => r('one'), 1_500)),
    ]);
    expect(loserSettled).toBe('one'); // i.e. one caller is parked holding the claim, not both done
    block.release();
    const results = await raced;
    block = null;
    for (const undo of restore) undo();

    const { winner, loser } = expectExactlyOneWinner(results, (o) => o.result === 'RAN');
    if (winner.result !== 'RAN') throw new Error('unreachable');
    expect(loser.ok).toBe(true);
    if (!loser.ok) throw new Error('the losing caller should be refused, not thrown at');
    expect(loser.value.result).toBe('CONFLICT');
    if (loser.value.result !== 'CONFLICT') throw new Error('unreachable');
    // Told who won — not a bare 409. Read against the winning claim rather than "whoever holds it now",
    // which by then may be nobody.
    expect(loser.value.inFlight).toEqual([
      expect.objectContaining({ zoneId: zoneId.toString(), runId: winner.summary.runId }),
    ]);

    // And exactly one of the two requests opened a ledger row — the loser rolled its own back whole.
    expect(await prismaA.dispatchRun.count({ where: { reason: { in: [`race-a-${NS}`, `race-b-${NS}`] } } })).toBe(1);
  }, 60_000);

  /**
   * The classic wedge, and a new shape of it: the guard used to be a `Map` entry deleted in a `finally`,
   * so a crash cost nothing beyond the process. A claim is a **row**, so a run that dies while still
   * holding one refuses that zone until somebody clears it.
   *
   * The break is aimed at the **per-zone finalize**, deliberately. Failing the run-level finalize
   * instead proves nothing: every claim has already been closed by then, so the release has nothing to
   * do and the test passes whether or not it exists — which is exactly how this test was first written.
   *
   * (`#261`'s reaper covers what this cannot — a process that never unwinds at all.)
   */
  it('finalizes its claims even when the run throws while holding one, so one failure does not wedge the zone', async () => {
    // #261 re-aimed this wedge. It used to break `dispatchRunZone.update`, which was then the per-zone
    // finalize's only writer; that finalize is now an `updateMany` conditional on the claim still being
    // RUNNING. Breaking `updateMany` wholesale would also break `releaseStrandedClaims` — the very
    // release this test exists to prove — so the patch discriminates on the argument that separates
    // them: the finalize names a single `zoneId`, the release does not.
    type ZoneWrite = { where?: { zoneId?: bigint } };
    const rows = (prismaA as unknown as { dispatchRunZone: { updateMany: (a: ZoneWrite) => unknown } }).dispatchRunZone;
    const originalUpdateMany = rows.updateMany;
    rows.updateMany = async (args: ZoneWrite) => {
      if (args.where?.zoneId != null) throw new Error('zone finalize exploded');
      return originalUpdateMany.call(rows, args);
    };
    await expect(serviceA.runForActiveZones(new Date(), { zoneId, trigger: 'MANUAL' })).rejects.toThrow(
      'zone finalize exploded',
    );
    rows.updateMany = originalUpdateMany;

    expect(await prismaA.dispatchRunZone.findFirst({ where: { zoneId, status: 'RUNNING' } })).toBeNull();
    const outcome = await serviceA.runForActiveZones(new Date(), { zoneId, trigger: 'MANUAL' });
    expect(outcome.result).toBe('RAN');
  }, 30_000);
});
