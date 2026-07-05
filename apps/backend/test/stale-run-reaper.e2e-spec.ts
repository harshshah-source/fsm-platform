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
});
