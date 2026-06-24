import { ConflictException } from '@nestjs/common';
import { SnapshotRunService } from '../src/ingestion/snapshot-run.service';
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

    await service.finishRun(runId, { status: 'SUCCESS', dataAsOf: asOf, cursor: '120' });

    const run = await prisma.snapshotRun.findUnique({ where: { runId } });
    expect(run?.status).toBe('SUCCESS');
    expect(run?.finishedAt).not.toBeNull();
    expect(run?.dataAsOf?.toISOString()).toBe(asOf.toISOString());
    expect(run?.cursor).toBe('120');
  });
});
