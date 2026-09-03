import { AutoPlantHealthService, type AutoPlantProbe } from '../src/ingestion/autoplant/health.service';
import { GATED_STAGES } from '../src/ingestion/ingestion-alert';
import { SnapshotQueryService } from '../src/ingestion/snapshot-query.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * #300 — the wedged-ingestion alert, against the real `snapshot_runs` / `snapshot_run_chunks` tables.
 *
 * `ingestion-alert.spec.ts` proves the streak arithmetic in isolation. This file proves the two
 * things that only a database can: that the Prisma reads select the right rows (newest first,
 * RUNNING excluded, chunks scoped to the streak), and that the banner feed and the OH health card —
 * which are two call sites of one derivation — return the same verdict.
 *
 * Every assertion is anchored on runs this file creates, which carry the highest `run_id`s in the
 * table by construction. The derivation only ever counts the LEADING block of non-SUCCESS runs, so a
 * seeded SUCCESS acts as a barrier: whatever other specs left behind is older and cannot be reached.
 * (The same technique #218's `quietRuns` uses, and for the same reason — see #215.)
 */
const probe: AutoPlantProbe = { isConfigured: () => false, ping: async () => ({ ok: true, vehicleRows: 0 }) };

describe('#300 — ingestion alert over the run ledger', () => {
  let prisma: PrismaService;
  let health: AutoPlantHealthService;
  let query: SnapshotQueryService;

  const runIds: bigint[] = [];

  const cleanup = async (): Promise<void> => {
    if (runIds.length === 0) return;
    // Chunks first — they carry the FK. Scoped to this file's own run ids, so a throw here can never
    // reach another spec's rows (the #215 trap, and the cleanup-leak trap the #299 session hit).
    const ids = [...runIds];
    runIds.length = 0;
    await prisma.snapshotRunChunk.deleteMany({ where: { runId: { in: ids } } });
    await prisma.snapshotRun.deleteMany({ where: { runId: { in: ids } } });
  };

  /** One finalized run, newest-last in call order. `chunkStats` mirrors what the worker now writes. */
  const seedRun = async (
    status: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'RUNNING',
    opts: {
      dataAsOf?: Date | null;
      chunkStats?: { rejected: Record<string, number>; repaired: Record<string, number> };
      failedChunk?: { chunkNo: number; error: string };
    } = {},
  ): Promise<bigint> => {
    const run = await prisma.snapshotRun.create({
      data: {
        status,
        finishedAt: status === 'RUNNING' ? null : new Date(),
        dataAsOf: opts.dataAsOf ?? null,
        ...(opts.chunkStats ? { chunkStats: opts.chunkStats } : {}),
      },
    });
    runIds.push(run.runId);
    if (opts.failedChunk) {
      await prisma.snapshotRunChunk.create({
        data: {
          runId: run.runId,
          chunkNo: opts.failedChunk.chunkNo,
          status: 'FAILED',
          retryCount: 2,
          error: opts.failedChunk.error,
        },
      });
    }
    return run.runId;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    health = new AutoPlantHealthService(prisma, probe);
    query = new SnapshotQueryService(prisma);
  });

  afterEach(cleanup);

  afterAll(async () => {
    await cleanup();
    await prisma.onModuleDestroy();
  });

  it('stays quiet while the newest run succeeded', async () => {
    await seedRun('PARTIAL');
    await seedRun('PARTIAL');
    await seedRun('SUCCESS', { dataAsOf: new Date('2026-09-01T10:00:00Z') });

    const alert = await health.ingestionHealth();

    expect(alert.streak).toBe(0);
    expect(alert.alert).toBe(false);
    expect(alert.downstreamGated).toBe(false);
    expect(alert.gatedStages).toEqual([]);
  });

  it('names the failing chunk, the repeat and the dropped rows once wedged', async () => {
    await seedRun('SUCCESS', { dataAsOf: new Date('2026-09-01T10:00:00Z') });
    const poison = 'device 0869925073271551: unparseable latest_gps_datetime';
    for (let i = 0; i < 3; i++) {
      await seedRun('PARTIAL', {
        dataAsOf: new Date('2026-09-01T11:00:00Z'),
        chunkStats: { rejected: { UNPARSEABLE_TIMESTAMP: 1 }, repaired: { MAINS_VOLTAGE_OUT_OF_RANGE: 2 } },
        failedChunk: { chunkNo: 7, error: poison },
      });
    }
    const newestRunId = runIds[runIds.length - 1];

    const alert = await health.ingestionHealth();

    // AC1 — every fact the operator needs to act, on one read.
    expect(alert.streak).toBe(3);
    expect(alert.alert).toBe(true);
    expect(alert.latestStatus).toBe('PARTIAL');
    expect(alert.failingChunk).toEqual({
      runId: newestRunId.toString(),
      chunkNo: 7,
      retryCount: 2,
      error: poison,
    });
    expect(alert.repeatingFailure).toBe(true);
    expect(alert.gatedStages).toEqual([...GATED_STAGES]);
    // #299's counters, now readable after the run rather than only in a log line the operator never saw.
    expect(alert.rejected).toEqual({ UNPARSEABLE_TIMESTAMP: 3 });
    expect(alert.repaired).toEqual({ MAINS_VOLTAGE_OUT_OF_RANGE: 6 });
  });

  it('an in-flight run neither resets the streak nor counts towards it', async () => {
    await seedRun('SUCCESS');
    await seedRun('PARTIAL', { failedChunk: { chunkNo: 1, error: 'poison' } });
    await seedRun('PARTIAL', { failedChunk: { chunkNo: 1, error: 'poison' } });
    // The retry that is itself about to fail must not make a wedged pipeline read as recovered.
    await seedRun('RUNNING');

    const alert = await health.ingestionHealth();

    expect(alert.streak).toBe(2);
    expect(alert.repeatingFailure).toBe(true);
    expect(alert.downstreamGated).toBe(true);
  });

  it('reports a read-failure streak with no failing chunk, rather than nothing', async () => {
    await seedRun('SUCCESS');
    await seedRun('PARTIAL');
    await seedRun('PARTIAL');
    await seedRun('PARTIAL');

    const alert = await health.ingestionHealth();

    expect(alert.streak).toBe(3);
    expect(alert.alert).toBe(true);
    // The source read died mid-scan: no chunk write ever failed, so there is nothing to name — and
    // the alert must still fire. This is exactly the AR-1 shape #299 contained.
    expect(alert.failingChunk).toBeNull();
    expect(alert.repeatingFailure).toBe(false);
  });

  it('the banner feed and the OH health card return the same verdict', async () => {
    await seedRun('SUCCESS', { dataAsOf: new Date('2026-09-01T10:00:00Z') });
    await seedRun('PARTIAL', { dataAsOf: new Date('2026-09-01T11:00:00Z') });
    await seedRun('PARTIAL', { dataAsOf: new Date('2026-09-01T11:30:00Z') });

    const [card, banner] = await Promise.all([health.ingestionHealth(), query.latest()]);

    expect(banner.ingestion).toEqual(card);
  });

  it('AC2/F10 — data-as-of stays on the SUCCESS watermark while the PARTIAL one is reported separately', async () => {
    const success = new Date('2026-09-01T10:00:00Z');
    const partial = new Date('2026-09-01T11:30:00Z');
    await seedRun('SUCCESS', { dataAsOf: success });
    await seedRun('PARTIAL', { dataAsOf: partial });

    const view = await query.latest();

    // The number an operator reads as "the fleet, as of" may never be advanced by a partial read…
    expect(view.dataAsOf).toBe(success.toISOString());
    // …but the PARTIAL watermark is real, is written on purpose, and is now reported under its own
    // name instead of being silently discarded (the F10 disagreement).
    expect(view.partialDataAsOf).toBe(partial.toISOString());
    // …and the banner is told the pipeline is gated, so it cannot render this as healthy freshness.
    expect(view.ingestion.downstreamGated).toBe(true);
  });

  it('does not report a PARTIAL watermark that is older than the last SUCCESS', async () => {
    await seedRun('PARTIAL', { dataAsOf: new Date('2026-09-01T09:00:00Z') });
    await seedRun('SUCCESS', { dataAsOf: new Date('2026-09-01T10:00:00Z') });

    const view = await query.latest();

    expect(view.partialDataAsOf).toBeNull();
    expect(view.ingestion.downstreamGated).toBe(false);
  });
});
