import { ConflictException } from '@nestjs/common';
import { SnapshotRunService } from '../src/ingestion/snapshot-run.service';
import { ORPHANED_RUN_ERROR } from '../src/ingestion/stale-run';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 04, slice 4 — snapshot run lifecycle + single in-flight guard.
 *
 * `startRun` opens a RUNNING run; at most one run may be in flight at a time (advisory lock +
 * the `WHERE status='RUNNING'` partial-unique backstop from slice 1). A second start while one
 * is RUNNING is rejected with a 409 (RUN_IN_PROGRESS) — this is what `POST /api/snapshots/run`
 * surfaces in slice 7. `finishRun` records the terminal status, `finished_at`, and `data_as_of`.
 */
describe('Issue 04 slice 4 — run lifecycle', () => {
  let prisma: PrismaService;
  let service: SnapshotRunService;
  const created: bigint[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new SnapshotRunService(prisma);
  });

  beforeEach(async () => {
    // Clear any leaked in-flight run so the global single-in-flight guard starts clean.
    await prisma.snapshotRun.deleteMany({ where: { status: 'RUNNING' } });
  });

  afterEach(async () => {
    if (created.length > 0) {
      await prisma.snapshotRun.deleteMany({ where: { runId: { in: created } } });
      created.length = 0;
    }
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it('opens a RUNNING run with no finished_at', async () => {
    const { runId } = await service.startRun();
    created.push(runId);

    const run = await prisma.snapshotRun.findUnique({ where: { runId } });
    expect(run?.status).toBe('RUNNING');
    expect(run?.finishedAt).toBeNull();
  });

  it('rejects a second run while one is in flight (409 RUN_IN_PROGRESS)', async () => {
    const { runId } = await service.startRun();
    created.push(runId);

    const err = await service.startRun().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getStatus()).toBe(409);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: 'RUN_IN_PROGRESS' });
  });

  it('clears the guard once the run finishes, allowing a new run', async () => {
    const first = await service.startRun();
    created.push(first.runId);
    await service.finishRun(first.runId, { status: 'SUCCESS', dataAsOf: new Date() });

    const second = await service.startRun();
    created.push(second.runId);

    expect(second.runId).not.toBe(first.runId);
  });

  it('finalizes a run with status, finished_at and data_as_of', async () => {
    const { runId } = await service.startRun();
    created.push(runId);
    const asOf = new Date(Date.UTC(2026, 5, 19, 8, 30, 0));

    await service.finishRun(runId, { status: 'SUCCESS', dataAsOf: asOf });

    const run = await prisma.snapshotRun.findUnique({ where: { runId } });
    expect(run?.status).toBe('SUCCESS');
    expect(run?.finishedAt).not.toBeNull();
    expect(run?.dataAsOf?.toISOString()).toBe(asOf.toISOString());
  });

  it('#324 F4 — nothing writes the resume cursor any more', async () => {
    // `snapshot_runs.cursor` held a cross-run re-read floor for a resume `AutoPlantSourceReader`
    // deliberately does not do: it restarts from a null cursor and keyset-scans every device on every
    // run, so correctness never depended on the watermark and nothing in production ever read it back.
    // The column stays (dropping it needs a migration for no behavioural gain, and stored values are
    // honest history); the write and its reader are gone. Pinned here so a future edit cannot quietly
    // revive a persisted value with a documented meaning nothing honours.
    const { runId } = await service.startRun();
    created.push(runId);

    await service.finishRun(runId, { status: 'PARTIAL', dataAsOf: new Date() });

    expect((await prisma.snapshotRun.findUnique({ where: { runId } }))?.cursor).toBeNull();
    expect('lastResumeCursor' in (service as unknown as Record<string, unknown>)).toBe(false);
    expect((service as unknown as Record<string, unknown>).lastResumeCursor).toBeUndefined();
  });

  /**
   * #348 — the reap now says WHY.
   *
   * `snapshot_runs` had no `error` column, so a run the heartbeat reaper closed (#261) left nothing
   * behind but a status flip and a `finished_at`. In the run history that is indistinguishable from a
   * run whose AutoPlant read genuinely threw — two entries that look identical and call for opposite
   * responses ("restart the box" vs "go look at the source data"). `master_sync_runs` has recorded
   * `ORPHANED_RUN_ERROR` for this since Issue 97; the snapshot ledger now matches it.
   */
  describe('#348 — a reaped run records its reason', () => {
    /** A run whose process died: RUNNING with a heartbeat well past the stale threshold. */
    const seedOrphan = async (minutesAgo = 90): Promise<bigint> => {
      const dead = new Date(Date.now() - minutesAgo * 60_000);
      const run = await prisma.snapshotRun.create({
        data: { status: 'RUNNING', startedAt: dead, heartbeatAt: dead },
      });
      created.push(run.runId);
      return run.runId;
    };

    it('marks an orphaned run FAILED with ORPHANED_RUN_ERROR', async () => {
      const runId = await seedOrphan();

      expect(await service.reapStaleRuns()).toBeGreaterThanOrEqual(1);

      const run = await prisma.snapshotRun.findUnique({ where: { runId } });
      expect(run?.status).toBe('FAILED');
      expect(run?.error).toBe(ORPHANED_RUN_ERROR);
      expect(run?.finishedAt).not.toBeNull();
    });

    it('reaps as a side effect of the next startRun, which is how it happens in production', async () => {
      const orphaned = await seedOrphan();

      const { runId } = await service.startRun();
      created.push(runId);

      expect((await prisma.snapshotRun.findUnique({ where: { runId: orphaned } }))?.error).toBe(ORPHANED_RUN_ERROR);
    });

    it('leaves a live run alone — a fresh heartbeat is not an orphan, and gets no reason', async () => {
      // The #261 rule: slow is not dead. A run still beating must not be reaped, and must certainly
      // not be labelled as having been restarted out from under itself.
      const { runId } = await service.startRun();
      created.push(runId);

      await service.reapStaleRuns();

      const run = await prisma.snapshotRun.findUnique({ where: { runId } });
      expect(run?.status).toBe('RUNNING');
      expect(run?.error).toBeNull();
    });

    it('a run that finishes normally carries no reason, so the marker keeps its meaning', async () => {
      const { runId } = await service.startRun();
      created.push(runId);

      await service.finishRun(runId, { status: 'FAILED', dataAsOf: null });

      const run = await prisma.snapshotRun.findUnique({ where: { runId } });
      expect(run?.status).toBe('FAILED');
      expect(run?.error).toBeNull();
    });
  });
});
