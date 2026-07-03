import { ConflictException } from '@nestjs/common';
import { MasterSyncRunService } from '../src/ingestion/autoplant/master-sync-run.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Phase 4 — master-sync run lifecycle + single in-flight guard (mirrors the snapshot_runs pattern).
 *
 * `startRun` opens a RUNNING `master_sync_runs` row; at most one may be in flight (advisory lock +
 * the `WHERE status='RUNNING'` partial-unique backstop added in 20260703120000). A second start while
 * one is RUNNING is a 409 (RUN_IN_PROGRESS) so overlapping scheduler ticks never double-sync.
 * `finishRun` records the terminal status, `finished_at`, per-entity `entity_stats`, and any error.
 */
describe('Phase 4 — master-sync run lifecycle', () => {
  let prisma: PrismaService;
  let service: MasterSyncRunService;
  const created: bigint[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new MasterSyncRunService(prisma);
  });

  beforeEach(async () => {
    await prisma.masterSyncRun.deleteMany({ where: { status: 'RUNNING' } });
  });

  afterEach(async () => {
    if (created.length > 0) {
      await prisma.masterSyncRun.deleteMany({ where: { runId: { in: created } } });
      created.length = 0;
    }
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it('opens a RUNNING run with no finished_at', async () => {
    const { runId } = await service.startRun();
    created.push(runId);

    const run = await prisma.masterSyncRun.findUnique({ where: { runId } });
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
    await service.finishRun(first.runId, { status: 'SUCCESS' });

    const second = await service.startRun();
    created.push(second.runId);

    expect(second.runId).not.toBe(first.runId);
  });

  it('finalizes a run with status, finished_at and per-entity stats', async () => {
    const { runId } = await service.startRun();
    created.push(runId);
    const stats = {
      companies: { inserted: 3, updated: 1, skipped: 0 },
      plants: { inserted: 2, updated: 0, skipped: 1 },
    };

    await service.finishRun(runId, { status: 'SUCCESS', entityStats: stats });

    const run = await prisma.masterSyncRun.findUnique({ where: { runId } });
    expect(run?.status).toBe('SUCCESS');
    expect(run?.finishedAt).not.toBeNull();
    expect(run?.entityStats).toMatchObject(stats);
    expect(run?.error).toBeNull();
  });

  it('records an error message on a FAILED run', async () => {
    const { runId } = await service.startRun();
    created.push(runId);

    await service.finishRun(runId, { status: 'FAILED', error: 'VPN egress lost mid-sync' });

    const run = await prisma.masterSyncRun.findUnique({ where: { runId } });
    expect(run?.status).toBe('FAILED');
    expect(run?.error).toBe('VPN egress lost mid-sync');
  });
});
