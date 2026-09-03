import { randomUUID } from 'node:crypto';
import { istDate } from '../src/common/ist-day';
import { PrismaService } from '../src/prisma/prisma.service';
import type { RecommenderService } from '../src/recommender/recommender.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { DispatchRunService } from '../src/scheduling/dispatch-run.service';

/**
 * #305 (forensics RC-5) — the dispatch heartbeat beats INSIDE the zone loop.
 *
 * #261 made the reaper judge a run by the freshness of its beat rather than by its age, which is what
 * lets a legitimately long run finish. But the beat was stamped at admission, after every zone, and
 * per patience iteration — never *during* a zone's work. So a run's silence was bounded by its slowest
 * single zone, and a zone whose recommend+dispatch outlasts `DISPATCH_STALE_RUN_MIN` (10 min) had its
 * **live** run marked ABORTED, its claim freed and a recovery mark written: the #286 collector could
 * then start a second dispatch of a zone whose first was still writing, and the ledger recorded
 * ABORTED for a run that completed. The risk grows with zone size — exactly when it matters.
 *
 * The subject is *when* the beat happens, so the tests measure that directly: a stub recommender and a
 * stub dispatch record the run's `heartbeat_at` at each step, and the assertions are about whether it
 * moved while the zone was still being worked. Nothing here sleeps for ten minutes.
 */
const NS = Date.now();

describe('#305 — a long zone cannot outlast its own heartbeat', () => {
  let prisma: PrismaService;
  let zoneId: bigint;
  let plantId: bigint;
  const runIds: bigint[] = [];
  const NOW = new Date();
  const DAY = istDate(NOW);

  const beatOf = async (runId: bigint): Promise<Date | null> =>
    (await prisma.dispatchRun.findUniqueOrThrow({ where: { runId }, select: { heartbeatAt: true } })).heartbeatAt;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    zoneId = (await prisma.zone.create({ data: { name: 'Z-305-' + NS } })).zoneId;
    plantId = (await prisma.plant.create({ data: { name: 'P-305-' + NS, zoneId } })).plantId;
  });

  afterEach(async () => {
    await prisma.dispatchRunZone.deleteMany({ where: { zoneId } });
    if (runIds.length > 0) {
      await prisma.dispatchRun.deleteMany({ where: { runId: { in: runIds } } });
      runIds.length = 0;
    }
    await prisma.dispatchZoneRecovery.deleteMany({ where: { zoneId } });
  });

  afterAll(async () => {
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  /**
   * AC1 — the beat moves while a zone is still being worked.
   *
   * Both phases are stubbed to call the `onProgress` they are handed and then report what the run's
   * heartbeat was at that instant. If the beat only happened between zones, every sample would equal
   * the admission beat.
   */
  it('AC1 — both recommendation and dispatch beat during the zone, not only after it', async () => {
    const beats: Array<{ phase: string; at: Date | null }> = [];
    let runId!: bigint;

    const recommender = {
      runForZone: async (_zone: bigint, opts: { runId?: bigint; onProgress?: () => Promise<void> }) => {
        runId = opts.runId!;
        runIds.push(runId);
        beats.push({ phase: 'recommend:before', at: await beatOf(runId) });
        // What the real loop does every N tickets.
        await new Promise((r) => setTimeout(r, 5));
        await opts.onProgress?.();
        beats.push({ phase: 'recommend:after', at: await beatOf(runId) });
        return {
          ticketsConsidered: 0,
          recommended: 0,
          unassignable: 0,
          withheldBelowThreshold: 0,
          bucketlessDropped: 0,
          componentBlockedWithheld: 0,
          assignmentThresholdHours: null,
          mode: 'DEFICIT',
          weightSetRef: '305-spec',
        };
      },
    } as unknown as RecommenderService;

    const dispatch = {
      dispatchForZone: async (_zone: bigint, opts: { onProgress?: () => Promise<void> }) => {
        beats.push({ phase: 'dispatch:before', at: await beatOf(runId) });
        await new Promise((r) => setTimeout(r, 5));
        await opts.onProgress?.(); // what the real loop does after each SE
        beats.push({ phase: 'dispatch:after', at: await beatOf(runId) });
        return { schedules: 0, batches: 0, tickets: 0 };
      },
    } as unknown as BatchAssignmentService;

    const service = new DispatchRunService(prisma, recommender, dispatch);
    const outcome = await service.runForActiveZones(NOW, { zoneId, retry: { intervalMs: 0, deadlineMs: 0 } });

    expect(outcome.result).toBe('RAN');
    const at = (phase: string) => beats.find((b) => b.phase === phase)!.at!.getTime();
    // The claim this issue is about: silence is bounded by per-SE / per-N-ticket work, not by the zone.
    expect(at('recommend:after')).toBeGreaterThan(at('recommend:before'));
    expect(at('dispatch:after')).toBeGreaterThan(at('dispatch:before'));
  });

  /**
   * AC2 — and it is the reaper's own predicate that has to be satisfied, not merely a moving column.
   * A run that beats during a slow zone is invisible to a reaper whose threshold is shorter than the
   * zone takes; before this, the same run was reaped mid-flight.
   */
  it('AC2 — a run that beats mid-zone survives a reaper whose threshold it would otherwise exceed', async () => {
    let reapedDuringZone = 0;
    let runId!: bigint;

    const service = new DispatchRunService(
      prisma,
      {
        runForZone: async (_z: bigint, opts: { runId?: bigint; onProgress?: () => Promise<void> }) => {
          runId = opts.runId!;
          runIds.push(runId);
          // The zone takes longer than the reaper's patience. Age the beat past the threshold, beat,
          // then let the reaper look — exactly the sequence a big zone produces.
          await prisma.dispatchRun.updateMany({
            where: { runId },
            data: { heartbeatAt: new Date(Date.now() - 60 * 60_000) },
          });
          await opts.onProgress?.();
          const { runs } = await service.reapStaleDispatchRuns(new Date());
          reapedDuringZone += runs;
          return {
            ticketsConsidered: 0,
            recommended: 0,
            unassignable: 0,
            withheldBelowThreshold: 0,
            bucketlessDropped: 0,
            componentBlockedWithheld: 0,
            assignmentThresholdHours: null,
            mode: 'DEFICIT',
            weightSetRef: '305-spec',
          };
        },
      } as unknown as RecommenderService,
      {
        dispatchForZone: async () => ({ schedules: 0, batches: 0, tickets: 0 }),
      } as unknown as BatchAssignmentService,
    );

    const outcome = await service.runForActiveZones(NOW, { zoneId, retry: { intervalMs: 0, deadlineMs: 0 } });

    expect(outcome.result).toBe('RAN');
    expect(reapedDuringZone).toBe(0);
    // The run finished on its own terms, and no second dispatch of the zone was ever invited.
    const run = await prisma.dispatchRun.findUniqueOrThrow({ where: { runId } });
    expect(run.status).toBe('SUCCESS');
    expect(await prisma.dispatchZoneRecovery.count({ where: { zoneId } })).toBe(0);
  });

  /**
   * AC3 — the beat is not a licence to survive death. A run that stops beating is reaped on exactly
   * the same threshold as before, and a late beat cannot resurrect it (#261's guarded-write rule).
   */
  it('AC3 — a genuinely dead run is still reaped, and a beat afterwards does not flip it back', async () => {
    const service = new DispatchRunService(
      prisma,
      { runForZone: async () => ({}) } as unknown as RecommenderService,
      { dispatchForZone: async () => ({ schedules: 0, batches: 0, tickets: 0 }) } as unknown as BatchAssignmentService,
    );
    const dead = await prisma.dispatchRun.create({
      data: {
        trigger: 'CRON',
        status: 'RUNNING',
        startedAt: new Date(Date.now() - 2 * 60 * 60_000),
        heartbeatAt: new Date(Date.now() - 2 * 60 * 60_000),
        configSnapshot: {},
      },
    });
    runIds.push(dead.runId);
    await prisma.dispatchRunZone.create({
      data: { runId: dead.runId, zoneId, status: 'RUNNING', startedAt: new Date(Date.now() - 2 * 60 * 60_000) },
    });

    const { runs } = await service.reapStaleDispatchRuns(new Date());
    expect(runs).toBeGreaterThanOrEqual(1);
    expect((await prisma.dispatchRun.findUniqueOrThrow({ where: { runId: dead.runId } })).status).toBe('ABORTED');

    // The zombie wakes up and beats. The write is guarded on `status: 'RUNNING'`, so it matches nothing.
    await prisma.dispatchRun.updateMany({ where: { runId: dead.runId, status: 'RUNNING' }, data: { heartbeatAt: new Date() } });
    expect((await prisma.dispatchRun.findUniqueOrThrow({ where: { runId: dead.runId } })).status).toBe('ABORTED');
  });
});
