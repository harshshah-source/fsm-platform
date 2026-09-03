import { ConflictException } from '@nestjs/common';
import { MasterSyncRunService } from '../src/ingestion/autoplant/master-sync-run.service';
import { SnapshotRunService } from '../src/ingestion/snapshot-run.service';
import {
  DEFAULT_STALE_RUN_MIN,
  ORPHANED_RUN_ERROR,
  readStaleRunMs,
} from '../src/ingestion/stale-run';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 97 Slice 2 (review A2) — stale-run reaper. A process death mid-run orphans a RUNNING row; the
 * partial-unique guard then rejects EVERY future run with 409 until someone deletes it by hand. The
 * reaper runs inside `startRun()`, before the lock, marking RUNNING rows older than
 * `INGESTION_STALE_RUN_MIN` as FAILED so unattended operation can recover. A genuinely in-flight
 * (fresh) run must still 409. Covers both run tables (master_sync_runs + snapshot_runs).
 */
describe('Issue 97 Slice 2 — stale-run reaper', () => {
  let prisma: PrismaService;
  const created: bigint[] = [];
  const HOUR_AGO = () => new Date(Date.now() - 60 * 60 * 1000);

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
  });

  beforeEach(async () => {
    await prisma.masterSyncRun.deleteMany({ where: { status: 'RUNNING' } });
    await prisma.snapshotRun.deleteMany({ where: { status: 'RUNNING' } });
  });

  afterEach(async () => {
    if (created.length > 0) {
      await prisma.masterSyncRun.deleteMany({ where: { runId: { in: created } } });
      await prisma.snapshotRun.deleteMany({ where: { runId: { in: created } } });
      created.length = 0;
    }
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it('master: reaps an orphaned RUNNING row and lets the next startRun proceed', async () => {
    const orphan = await prisma.masterSyncRun.create({
      data: { status: 'RUNNING', startedAt: HOUR_AGO() },
    });
    created.push(orphan.runId);

    const { runId } = await new MasterSyncRunService(prisma).startRun();
    created.push(runId);

    const reaped = await prisma.masterSyncRun.findUnique({ where: { runId: orphan.runId } });
    expect(reaped?.status).toBe('FAILED');
    expect(runId).not.toBe(orphan.runId); // a fresh run opened rather than 409-ing
  });

  it('master: leaves a fresh RUNNING row alone — next startRun still 409s', async () => {
    const fresh = await prisma.masterSyncRun.create({ data: { status: 'RUNNING' } });
    created.push(fresh.runId);

    const err = await new MasterSyncRunService(prisma).startRun().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getStatus()).toBe(409);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: 'RUN_IN_PROGRESS' });

    const untouched = await prisma.masterSyncRun.findUnique({ where: { runId: fresh.runId } });
    expect(untouched?.status).toBe('RUNNING');
  });

  it('master: reaped row records the orphan error and a finished_at', async () => {
    const orphan = await prisma.masterSyncRun.create({
      data: { status: 'RUNNING', startedAt: HOUR_AGO() },
    });
    created.push(orphan.runId);

    await new MasterSyncRunService(prisma).reapStaleRuns();

    const reaped = await prisma.masterSyncRun.findUnique({ where: { runId: orphan.runId } });
    expect(reaped?.status).toBe('FAILED');
    expect(reaped?.error).toBe(ORPHANED_RUN_ERROR);
    expect(reaped?.finishedAt).not.toBeNull();
  });

  it('snapshot: reaps an orphaned RUNNING row and lets the next startRun proceed', async () => {
    const orphan = await prisma.snapshotRun.create({
      data: { status: 'RUNNING', startedAt: HOUR_AGO() },
    });
    created.push(orphan.runId);

    const { runId } = await new SnapshotRunService(prisma).startRun();
    created.push(runId);

    const reaped = await prisma.snapshotRun.findUnique({ where: { runId: orphan.runId } });
    expect(reaped?.status).toBe('FAILED');
    expect(reaped?.finishedAt).not.toBeNull(); // no error column on snapshot_runs — status flip + finished_at are the record
    expect(runId).not.toBe(orphan.runId);
  });

  it('snapshot: leaves a fresh RUNNING row alone — next startRun still 409s', async () => {
    const fresh = await prisma.snapshotRun.create({ data: { status: 'RUNNING' } });
    created.push(fresh.runId);

    const err = await new SnapshotRunService(prisma).startRun().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getStatus()).toBe(409);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: 'RUN_IN_PROGRESS' });

    const untouched = await prisma.snapshotRun.findUnique({ where: { runId: fresh.runId } });
    expect(untouched?.status).toBe('RUNNING');
  });

  it('readStaleRunMs: 30-min default, INGESTION_STALE_RUN_MIN override, garbage falls back', () => {
    expect(DEFAULT_STALE_RUN_MIN).toBe(30);
    expect(readStaleRunMs({})).toBe(30 * 60_000);
    expect(readStaleRunMs({ INGESTION_STALE_RUN_MIN: '5' })).toBe(300_000);
    expect(readStaleRunMs({ INGESTION_STALE_RUN_MIN: 'not-a-number' })).toBe(30 * 60_000);
    expect(readStaleRunMs({ INGESTION_STALE_RUN_MIN: '-1' })).toBe(30 * 60_000);
  });

  /**
   * #261 / #132 — **zombie resurrect.** The reaper exists because a process death orphans a RUNNING
   * row, but the process is not always dead: a run slow enough to be reaped can still be alive, finish
   * its work, and call `finishRun`. An unconditional update then overwrites the reaper's FAILED with
   * SUCCESS — so the ledger reports a successful run that nobody was tracking any more, and (on the
   * master-sync side) wipes the orphan error that explains what happened.
   *
   * The finish has to be conditional on the row still being RUNNING. Whoever got there first wins, and
   * a reaped run stays reaped.
   */
  it("master: a reaped run's late finishRun is a no-op — the row stays FAILED", async () => {
    const orphan = await prisma.masterSyncRun.create({
      data: { status: 'RUNNING', startedAt: HOUR_AGO() },
    });
    created.push(orphan.runId);
    const runs = new MasterSyncRunService(prisma);
    await runs.reapStaleRuns();

    // The zombie wakes up and reports success.
    await runs.finishRun(orphan.runId, { status: 'SUCCESS', entityStats: { devices: { inserted: 9, updated: 0, skipped: 0 } } });

    const after = await prisma.masterSyncRun.findUnique({ where: { runId: orphan.runId } });
    expect(after?.status).toBe('FAILED');
    expect(after?.error).toBe(ORPHANED_RUN_ERROR); // the explanation survives too
    expect(after?.entityStats).toBeNull();
  });

  it("snapshot: a reaped run's late finishRun is a no-op — the row stays FAILED", async () => {
    const orphan = await prisma.snapshotRun.create({
      data: { status: 'RUNNING', startedAt: HOUR_AGO() },
    });
    created.push(orphan.runId);
    const runs = new SnapshotRunService(prisma);
    await runs.reapStaleRuns();

    await runs.finishRun(orphan.runId, { status: 'SUCCESS', dataAsOf: new Date() });

    const after = await prisma.snapshotRun.findUnique({ where: { runId: orphan.runId } });
    expect(after?.status).toBe('FAILED');
    // The display watermark must not advance on a run nobody was tracking — that is the whole reason
    // `data_as_of` is left null for a failed run in the first place.
    expect(after?.dataAsOf).toBeNull();
    expect(after?.cursor).toBeNull();
  });

  /**
   * #261 / #132 — **liveness is a heartbeat, not a start time.** Judging staleness from `started_at`
   * alone reaps a run for being slow. The master sync legitimately runs long against AutoPlant, and a
   * reaped-but-alive run then loses its result (the conditional finish above) *and* frees the guard for
   * a second sync to start over the top of it. What makes a run stale is that nothing has touched it,
   * which is what `heartbeat_at` records.
   */
  it('snapshot: a slow-but-alive run is not reaped — a fresh heartbeat outlives an old startedAt', async () => {
    const slow = await prisma.snapshotRun.create({
      data: { status: 'RUNNING', startedAt: HOUR_AGO(), heartbeatAt: new Date() },
    });
    created.push(slow.runId);

    const reaped = await new SnapshotRunService(prisma).reapStaleRuns();

    expect(reaped).toBe(0);
    const after = await prisma.snapshotRun.findUnique({ where: { runId: slow.runId } });
    expect(after?.status).toBe('RUNNING');
  });

  it('master: a slow-but-alive run is not reaped — a fresh heartbeat outlives an old startedAt', async () => {
    const slow = await prisma.masterSyncRun.create({
      data: { status: 'RUNNING', startedAt: HOUR_AGO(), heartbeatAt: new Date() },
    });
    created.push(slow.runId);

    const reaped = await new MasterSyncRunService(prisma).reapStaleRuns();

    expect(reaped).toBe(0);
    const after = await prisma.masterSyncRun.findUnique({ where: { runId: slow.runId } });
    expect(after?.status).toBe('RUNNING');
  });

  /**
   * A stale heartbeat is what gets reaped — and a row that never beat at all (every run written before
   * this column existed) still falls back to `started_at`, so the reaper does not quietly stop working
   * on the exact population it was built for.
   */
  it('reaps on a stale heartbeat, and still reaps a row that never beat at all', async () => {
    // One RUNNING row per table is all the in-flight guard index permits, so the two arms of the
    // liveness predicate are staged one per ledger — which also proves both callers spell it the same.
    const beatLongAgo = await prisma.snapshotRun.create({
      data: { status: 'RUNNING', startedAt: new Date(), heartbeatAt: HOUR_AGO() },
    });
    const neverBeat = await prisma.masterSyncRun.create({
      data: { status: 'RUNNING', startedAt: HOUR_AGO(), heartbeatAt: null },
    });
    created.push(beatLongAgo.runId, neverBeat.runId);

    expect(await new SnapshotRunService(prisma).reapStaleRuns()).toBe(1);
    expect(await new MasterSyncRunService(prisma).reapStaleRuns()).toBe(1);

    // Reaped for a stale beat even though it started seconds ago — liveness is the beat, not the age.
    expect((await prisma.snapshotRun.findUnique({ where: { runId: beatLongAgo.runId } }))?.status).toBe('FAILED');
    // And the pre-heartbeat population still falls back to `started_at`.
    expect((await prisma.masterSyncRun.findUnique({ where: { runId: neverBeat.runId } }))?.status).toBe('FAILED');
  });

  /** The beat itself: a stage boundary touches it, and that is what buys the run its next window. */
  it('heartbeat() advances the beat on a live run and never revives a reaped one', async () => {
    const live = await prisma.snapshotRun.create({
      data: { status: 'RUNNING', startedAt: HOUR_AGO(), heartbeatAt: HOUR_AGO() },
    });
    const dead = await prisma.snapshotRun.create({
      data: { status: 'FAILED', startedAt: HOUR_AGO(), heartbeatAt: HOUR_AGO() },
    });
    created.push(live.runId, dead.runId);
    const runs = new SnapshotRunService(prisma);

    await runs.heartbeat(live.runId);
    await runs.heartbeat(dead.runId);

    const beat = await prisma.snapshotRun.findUnique({ where: { runId: live.runId } });
    expect(beat?.heartbeatAt?.getTime()).toBeGreaterThan(HOUR_AGO().getTime());
    // The reaper only looks at RUNNING rows, so a beat on a terminal run could not un-reap it — but
    // leaving a FAILED row with a fresh beat would still read as a live run to a human.
    const untouched = await prisma.snapshotRun.findUnique({ where: { runId: dead.runId } });
    expect(untouched?.heartbeatAt?.getTime()).toBeLessThan(Date.now() - 30 * 60_000);
  });

  /** A live run's finish is unaffected — the guard must not cost the normal path its result. */
  it('a still-RUNNING run finishes normally', async () => {
    const live = await prisma.snapshotRun.create({ data: { status: 'RUNNING' } });
    created.push(live.runId);

    const asOf = new Date();
    await new SnapshotRunService(prisma).finishRun(live.runId, { status: 'SUCCESS', dataAsOf: asOf });

    const after = await prisma.snapshotRun.findUnique({ where: { runId: live.runId } });
    expect(after?.status).toBe('SUCCESS');
    // Was `cursor: 'c-9'` — #324 (F4) removed that parameter along with the resume machinery nothing
    // read. `data_as_of` is the write this case needs anyway: it is what the guard must not lose.
    expect(after?.dataAsOf?.toISOString()).toBe(asOf.toISOString());
    expect(after?.finishedAt).not.toBeNull();
  });
});
