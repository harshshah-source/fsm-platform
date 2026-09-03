import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import type { BatchAssignmentService as BatchAssignmentServiceType } from '../src/scheduling/batch-assignment.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { DispatchRunService } from '../src/scheduling/dispatch-run.service';
import type { RecommenderService } from '../src/recommender/recommender.service';
import { dispatchZoneLockKey } from '../src/scheduling/dispatch-zone-lock';

/**
 * #262 — the dispatch write unit shrinks from the ZONE to the SE.
 *
 * `dispatchForZone` was one transaction for the whole zone. Three consequences, all of them the kind
 * that only show up in production: any single conflict rolled back **every** SE's day plan (and got
 * mislabelled `SCHEDULE_CONFLICT` whatever it was); the transaction's duration grew with the zone, at
 * roughly three round-trips per ticket, against a Prisma interactive-transaction budget of 5 s that
 * nobody had chosen; and recommendation consumption was one zone-wide flip at the end, so a concurrent
 * claimer collided rather than simply not seeing the rows.
 *
 * One transaction per SE fixes all three. Each SE's transaction claims **that SE's** recommendation
 * rows with `SELECT … FOR UPDATE SKIP LOCKED`, which is the point of this spec's first test: a
 * concurrent claimer's rows become *invisible* rather than a P2002, so nobody has to recover from a
 * collision that need not have happened.
 *
 * The isolation claim is asserted the only way that means anything — by making one SE fail for real
 * and checking the others' rows are committed, rather than by checking a returned count.
 */
const NS = Date.now();
const NOW = new Date('2026-06-21T06:00:00Z');
const DAY = new Date(Date.UTC(2026, 5, 21));

interface Seeded {
  zoneId: bigint;
  /** One SE per entry, each with its own plant and its own tickets — so an SE maps 1:1 to a stop. */
  ses: Array<{ seId: string; plantId: bigint; ticketIds: string[] }>;
}

describe('#262 — per-SE dispatch transactions (e2e)', () => {
  let prisma: PrismaService;
  /** A second pool, standing in for the concurrent claimer / lock holder. */
  let other: PrismaService;
  let dispatch: BatchAssignmentService;

  const zoneIds: bigint[] = [];
  const companyIds: bigint[] = [];
  const plantIds: bigint[] = [];
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  const runIds: bigint[] = [];

  const newRun = async (): Promise<bigint> => {
    const run = await prisma.dispatchRun.create({
      data: { trigger: 'MANUAL', startedAt: NOW, heartbeatAt: NOW, configSnapshot: {} },
    });
    runIds.push(run.runId);
    return run.runId;
  };

  /**
   * A zone with `seCount` dedicated SEs, one plant each, `perSe` OPEN tickets each.
   *
   * `capacity` defaults to 20 — enough for every case here except the throughput one, which
   * deliberately offers 40 per SE. Since #304 the engine caps a dispatch at the engineer's remaining
   * `daily_capacity` at commit time, so that case has to raise the cap or it would be measuring the
   * capacity guard rather than the transaction budget it is named for.
   */
  const seedZone = async (label: string, seCount: number, perSe: number, capacity = 20): Promise<Seeded> => {
    const zoneId = (await prisma.zone.create({ data: { name: `Z-${label}-${NS}` } })).zoneId;
    zoneIds.push(zoneId);
    const companyId = (
      await prisma.company.create({ data: { name: `Co-${label}-${NS}`, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    companyIds.push(companyId);

    const ses: Seeded['ses'] = [];
    for (let s = 0; s < seCount; s++) {
      const plantId = (await prisma.plant.create({ data: { name: `P-${label}-${s}-${NS}`, zoneId } })).plantId;
      plantIds.push(plantId);
      const tag = randomUUID().slice(0, 8);
      const u = await prisma.user.create({
        data: { name: `SE ${tag}`, role: 'SERVICE_ENGINEER', phone: `ph-${tag}`, email: `${tag}@perse.test`, zoneId },
      });
      userIds.push(u.userId);
      await prisma.engineerMaster.create({
        data: { engineerId: u.userId, coverageType: 'DEDICATED', zoneId, dailyCapacity: capacity },
      });
      await prisma.seCoverage.create({ data: { seId: u.userId, plantId, coverageType: 'DEDICATED' } });

      const mine: string[] = [];
      for (let i = 0; i < perSe; i++) {
        const deviceId = String(9_262_000_000 + (NS % 100_000) * 1000 + deviceIds.length);
        deviceIds.push(deviceId);
        await prisma.device.create({ data: { deviceId } });
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
        mine.push(ticket.ticketId);
      }
      ses.push({ seId: u.userId, plantId, ticketIds: mine });
    }
    return { zoneId, ses };
  };

  /**
   * Write the SUGGESTED recommendations the recommender would have written. Done directly so the test
   * controls exactly which SE owns which ticket — the recommender's own selection is #266's subject and
   * would make this spec's fixtures depend on scoring.
   */
  const suggest = async (seeded: Seeded, runId: bigint): Promise<void> => {
    let rank = 0;
    for (const se of seeded.ses) {
      for (const ticketId of se.ticketIds) {
        rank++;
        await prisma.recommendation.create({
          data: {
            ticketId,
            seId: se.seId,
            status: 'SUGGESTED',
            path: 'MORNING_BATCH',
            scoreBreakdown: {},
            processingRank: rank,
            runId,
          },
        });
      }
    }
  };

  /** Live (non-removed) batch rows for these tickets — the G1 surface, read table-wide. */
  const liveAssignments = (ids: string[]) =>
    prisma.batchAssignmentTicket.findMany({ where: { ticketId: { in: ids }, removedAt: null } });

  const schedulesFor = (seId: string) => prisma.workSchedule.findMany({ where: { seId } });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    other = new PrismaService();
    await other.onModuleInit();
    // A short lock timeout keeps the contention test fast. Passed through the service's own config
    // param rather than an env var, per #182 R5.
    dispatch = new BatchAssignmentService(prisma, undefined, { zoneLockTimeoutMs: 250 });
  });

  afterAll(async () => {
    await prisma.dispatchDecisionTrace.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    const schedules = await prisma.workSchedule.findMany({
      where: { zoneId: { in: zoneIds } },
      select: { scheduleId: true },
    });
    const batches = await prisma.plantBatchAssignment.findMany({
      where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } },
      select: { batchId: true },
    });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.workSchedule.deleteMany({ where: { zoneId: { in: zoneIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seCoverage.deleteMany({ where: { plantId: { in: plantIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: plantIds } } });
    await prisma.dispatchRunZone.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.dispatchRun.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.company.deleteMany({ where: { companyId: { in: companyIds } } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: zoneIds } } });
    await prisma.onModuleDestroy();
    await other.onModuleDestroy();
  });

  /**
   * The SKIP LOCKED contract, and the reason the claim is per SE.
   *
   * A second claimer holding one SE's recommendation rows must make that SE **invisible** to this
   * dispatch, not collide with it. Under the old zone-wide transaction there was no row claiming at
   * all — consumption was a single `updateMany` at the very end — so a concurrent claimer produced a
   * P2002 that rolled back the entire zone. Here the other SEs must be untouched by it.
   */
  it('skips an SE whose recommendations another claimer holds, and dispatches the rest', async () => {
    const seeded = await seedZone('skiplocked', 3, 2);
    const runId = await newRun();
    await suggest(seeded, runId);
    const locked = seeded.ses[1];

    // Hold SE[1]'s rows on a second connection for the duration of the dispatch. `FOR UPDATE` without
    // SKIP LOCKED is what a competing claimer's own transaction would take.
    let release!: () => void;
    const holding = new Promise<void>((r) => (release = () => r()));
    const holder = other.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT 1 FROM "recommendations"
         WHERE "se_id" = ${locked.seId}::uuid AND "status" = 'SUGGESTED'
           FOR UPDATE`;
      await holding;
    });
    await new Promise((r) => setTimeout(r, 150)); // let the holder take its locks

    const out = await dispatch.dispatchForZone(seeded.zoneId, { dateFrom: DAY, dateTo: DAY, now: NOW, runId });

    release();
    await holder;

    // Two SEs dispatched; the locked one was simply not there.
    expect(out.tickets).toBe(4);
    expect(out.schedules).toBe(2);
    expect(await schedulesFor(locked.seId)).toHaveLength(0);
    for (const se of [seeded.ses[0], seeded.ses[2]]) {
      expect(await schedulesFor(se.seId)).toHaveLength(1);
      expect(await liveAssignments(se.ticketIds)).toHaveLength(2);
    }
    // And the locked SE's tickets are untouched — not assigned, not consumed.
    expect(await liveAssignments(locked.ticketIds)).toHaveLength(0);
    const stillSuggested = await prisma.recommendation.findMany({
      where: { ticketId: { in: locked.ticketIds }, status: 'SUGGESTED' },
    });
    expect(stillSuggested).toHaveLength(2);
  }, 60_000);

  /**
   * #262 items 2 and 3 — the zone advisory lock is now **blocking with a bound**, and running out of
   * that bound is one SE's skip rather than an exception out of the dispatch.
   *
   * The lock's job changed: run-vs-run exclusion moved to #259's zone claim, so what it still guards is
   * dispatch against closure and bulk-unassign. A non-blocking `try` would abandon a zone that was free
   * a millisecond later; an unbounded wait would let one stuck holder stall the dispatch indefinitely.
   * Bounded blocking is the middle, and the ledger has to say when the bound was hit.
   */
  it('records a zone-lock timeout as a per-SE skip, never as a thrown error or a silent no-op', async () => {
    const seeded = await seedZone('locktimeout', 2, 1);
    const runId = await newRun();
    await suggest(seeded, runId);

    // Somebody else owns the zone for the whole dispatch — what a long bulk-unassign looks like.
    let release!: () => void;
    const holding = new Promise<void>((r) => (release = () => r()));
    const holder = other.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${dispatchZoneLockKey(seeded.zoneId)}))`;
        await holding;
      },
      { timeout: 30_000 },
    );
    await new Promise((r) => setTimeout(r, 150));

    const out = await dispatch.dispatchForZone(seeded.zoneId, { dateFrom: DAY, dateTo: DAY, now: NOW, runId });

    release();
    await holder;

    expect(out.tickets).toBe(0);
    // Every SE is named, and named with the reason — not a bare zero and not `SCHEDULE_CONFLICT`,
    // which is what the old zone-wide handler would have called this.
    expect(out.seSkips).toHaveLength(2);
    for (const skip of out.seSkips ?? []) {
      expect(skip.reason).toMatch(/^ZONE_LOCK_TIMEOUT: /);
      expect(skip.constraint).toBeNull();
    }
    expect(out.skipReason).toBeUndefined();
    expect(new Set((out.seSkips ?? []).map((s) => s.seId))).toEqual(new Set(seeded.ses.map((s) => s.seId)));

    // And this run's leftover SUGGESTED rows for those SEs are cleared, so they cannot poison the next
    // run — the rows were ours, we failed on them, and nobody else is holding them.
    const leftover = await prisma.recommendation.findMany({
      where: { runId, status: 'SUGGESTED' },
    });
    expect(leftover).toHaveLength(0);
    expect(out.orphansCleared).toBe(2);
  }, 60_000);

  /**
   * #262 item 3 — a per-SE skip is only useful if it reaches the ledger. The zone card is where an
   * operator looks when an engineer has no day plan, and "the zone dispatched 4 of 5 SEs" is invisible
   * unless the fifth is named there with its reason.
   *
   * Driven through `DispatchRunService` with stubs, because what is under test is the ledger write, not
   * the dispatch that produced the skips.
   */
  it('persists per-SE skips onto the dispatch_run_zones row', async () => {
    const seeded = await seedZone('ledger', 1, 1);
    const skips = [
      { seId: seeded.ses[0].seId, reason: 'SCHEDULE_CONFLICT: this SE already holds an ACTIVE schedule', constraint: 'WorkSchedule' },
    ];
    const stubRecommender = {
      runForZone: async () => ({
        ticketsConsidered: 0,
        recommended: 0,
        unassignable: 0,
        withheldBelowThreshold: 0,
        bucketlessDropped: 0,
        componentBlockedWithheld: 0,
        assignmentThresholdHours: null,
        mode: 'DEFICIT',
        weightSetRef: 'se-skips-spec',
      }),
    } as unknown as RecommenderService;
    const stubDispatch = {
      dispatchForZone: async () => ({ schedules: 0, batches: 0, tickets: 0, seSkips: skips }),
    } as unknown as BatchAssignmentServiceType;

    const runs = new DispatchRunService(prisma, stubRecommender, stubDispatch);
    const outcome = await runs.runForActiveZones(new Date(), {
      zoneId: seeded.zoneId,
      trigger: 'MANUAL',
      reason: `se-skips-${NS}`,
    });
    expect(outcome.result).toBe('RAN');
    if (outcome.result !== 'RAN') return;
    runIds.push(BigInt(outcome.summary.runId));

    const zoneRow = await prisma.dispatchRunZone.findFirstOrThrow({
      where: { runId: BigInt(outcome.summary.runId), zoneId: seeded.zoneId },
    });
    expect(zoneRow.seSkips).toEqual(skips);
    // A zone whose SEs were skipped is not a zone that failed as a whole: `error` stays null, exactly
    // as #262 requires of a per-SE condition, so the run's Errors column does not claim a zone error.
    expect(zoneRow.error).toBeNull();
  }, 60_000);

  /**
   * AC-2 — transaction duration is a function of `daily_capacity`, not of zone size.
   *
   * This is the change that takes the interactive-transaction budget off the critical path. The old
   * shape was ONE transaction doing roughly three round-trips per ticket for the whole zone, so a
   * zone's dispatch got slower as the zone got bigger and eventually crossed a 5 s ceiling nobody had
   * chosen — with the failure landing as a Prisma timeout that named nothing about the work it lost.
   *
   * Asserted as the property that actually matters: a zone far larger than any fixture in this suite
   * dispatches completely, and the WHOLE zone — every per-SE transaction summed — still fits inside
   * the budget that used to have to hold a single transaction. Any one transaction is therefore
   * comfortably inside it, with room the old shape did not have.
   */
  it('dispatches a large zone with every transaction far inside the 15s budget', async () => {
    const SES = 4;
    const PER_SE = 40;
    // Capacity above `PER_SE`: this case measures the per-SE transaction budget, and since #304 a
    // capacity-20 engineer would legitimately be capped at 20 of the 40 offered — a different subject.
    const seeded = await seedZone('bulk', SES, PER_SE, PER_SE + 10);
    const runId = await newRun();
    await suggest(seeded, runId);

    const startedAt = Date.now();
    const out = await dispatch.dispatchForZone(seeded.zoneId, { dateFrom: DAY, dateTo: DAY, now: NOW, runId });
    const elapsed = Date.now() - startedAt;

    expect(out.tickets).toBe(SES * PER_SE);
    expect(out.schedules).toBe(SES);
    expect(out.seSkips).toBeUndefined();
    // 160 tickets is ~480 statements. The old single transaction had to hold all of them inside one
    // 15 s budget; here that budget covers all four transactions together, so no single one is close.
    expect(elapsed).toBeLessThan(15_000);

    // And the work is actually there — a fast run that dispatched nothing would pass a timing check.
    const all = seeded.ses.flatMap((se) => se.ticketIds);
    expect(await liveAssignments(all)).toHaveLength(all.length);
  }, 120_000);

  /**
   * AC-7 — #123's reconciliation invariant survives partial outcomes.
   *
   * A run's totals must equal the sum of its zone rows. That was easy to hold when a zone either
   * dispatched entirely or rolled back entirely; #262 and #259 between them introduced two ways for a
   * run to be partial — an SE skipped inside a zone that otherwise dispatched, and a zone the run was
   * refused altogether. A fixture producing BOTH in one run is the only way to know the arithmetic
   * still closes.
   */
  it('run totals equal the sum of its zone rows with a per-SE skip AND a contended zone', async () => {
    const worked = await seedZone('recon-a', 2, 2);
    const contested = await seedZone('recon-b', 1, 1);

    // Somebody else already holds the second zone — #259's CONTENDED case.
    const holderRun = await prisma.dispatchRun.create({
      data: { trigger: 'MANUAL', status: 'RUNNING', startedAt: NOW, heartbeatAt: new Date(), configSnapshot: {} },
    });
    runIds.push(holderRun.runId);
    await prisma.dispatchRunZone.create({
      data: { runId: holderRun.runId, zoneId: contested.zoneId, status: 'RUNNING', startedAt: NOW },
    });

    // A dispatcher that dispatches one SE and skips the other — #262's case.
    const skips = [{ seId: worked.ses[1].seId, reason: 'SCHEDULE_CONFLICT: staged', constraint: 'WorkSchedule' }];
    const stubRecommender = {
      runForZone: async () => ({
        ticketsConsidered: 4,
        recommended: 4,
        unassignable: 1,
        withheldBelowThreshold: 0,
        bucketlessDropped: 0,
        componentBlockedWithheld: 0,
        assignmentThresholdHours: null,
        mode: 'DEFICIT',
        weightSetRef: 'recon-spec',
      }),
    } as unknown as RecommenderService;
    const stubDispatch = {
      dispatchForZone: async () => ({ schedules: 1, batches: 1, tickets: 2, seSkips: skips }),
    } as unknown as BatchAssignmentServiceType;

    const runs = new DispatchRunService(prisma, stubRecommender, stubDispatch);
    const outcome = await runs.runForActiveZones(new Date(), {
      trigger: 'MANUAL',
      reason: `recon-${NS}`,
      retry: { intervalMs: 60_000, deadlineMs: 0 }, // try-once: the contended zone must STAY contended
    });
    expect(outcome.result).toBe('RAN');
    if (outcome.result !== 'RAN') return;
    const runId = BigInt(outcome.summary.runId);
    runIds.push(runId);

    const run = await prisma.dispatchRun.findUniqueOrThrow({ where: { runId } });
    const zoneRows = await prisma.dispatchRunZone.findMany({ where: { runId } });

    // Both shapes are present, or this fixture is not testing what it claims to.
    expect(zoneRows.some((z) => z.status === 'CONTENDED')).toBe(true);
    expect(zoneRows.some((z) => z.seSkips !== null)).toBe(true);

    const sum = (pick: (z: (typeof zoneRows)[number]) => number) => zoneRows.reduce((a, z) => a + pick(z), 0);
    expect(run.schedules).toBe(sum((z) => z.schedules));
    expect(run.batches).toBe(sum((z) => z.batches));
    expect(run.ticketsDispatched).toBe(sum((z) => z.ticketsDispatched));
    expect(run.recommended).toBe(sum((z) => z.recommended));
    expect(run.unassignable).toBe(sum((z) => z.unassignable));
    // The contended zone contributes zeros to every column — it is a zone this run never worked, and
    // the arithmetic only closes because the ledger says so rather than inferring it.
    const contendedRow = zoneRows.find((z) => z.status === 'CONTENDED');
    expect(contendedRow).toMatchObject({ schedules: 0, batches: 0, ticketsDispatched: 0, recommended: 0 });
  }, 120_000);

  /**
   * G1, stated on the rows: no ticket is ever on two live batch rows. Re-invoking after a partial
   * dispatch must pick up only what is left, which is the property the per-SE guard re-read exists for
   * — the zone-wide read happened once, before any SE committed, so it could not see its own progress.
   */
  it('re-invoked after a partial dispatch, it completes the rest and never double-assigns', async () => {
    const seeded = await seedZone('reinvoke', 3, 2);
    const runId = await newRun();
    await suggest(seeded, runId);
    const locked = seeded.ses[2];

    let release!: () => void;
    const holding = new Promise<void>((r) => (release = () => r()));
    const holder = other.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT 1 FROM "recommendations"
         WHERE "se_id" = ${locked.seId}::uuid AND "status" = 'SUGGESTED'
           FOR UPDATE`;
      await holding;
    });
    await new Promise((r) => setTimeout(r, 150));
    const first = await dispatch.dispatchForZone(seeded.zoneId, { dateFrom: DAY, dateTo: DAY, now: NOW, runId });
    release();
    await holder;
    expect(first.tickets).toBe(4);

    // The claimer is gone; the same run dispatches again and finds only the SE it missed.
    const second = await dispatch.dispatchForZone(seeded.zoneId, { dateFrom: DAY, dateTo: DAY, now: NOW, runId });
    expect(second.tickets).toBe(2);

    // G1 table-wide (the #241 style): every ticket in this zone sits on exactly one live batch row.
    const all = seeded.ses.flatMap((s) => s.ticketIds);
    const live = await liveAssignments(all);
    expect(live).toHaveLength(all.length);
    expect(new Set(live.map((r) => r.ticketId)).size).toBe(all.length);
  }, 60_000);
});
