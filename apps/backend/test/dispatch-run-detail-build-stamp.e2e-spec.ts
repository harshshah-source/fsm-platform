import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/prisma/prisma.service';
import { DispatchTransparencyQueryService } from '../src/scheduling/dispatch-transparency-query.service';

/**
 * #131 — the dispatch-run-detail stale-build badge. `getRunDetail` already reads the full
 * `dispatch_runs` row (Prisma `include`, not `select`, so `build_version`/`build_fingerprint` are
 * already fetched); this pins that they are surfaced on the response as a `build` stamp, flagged
 * `staleBuild` against the current `runtime_lock` high-water mark — the same shape
 * `AutoPlantHealthService` already uses for `masterSync.build`/`snapshot.build` (#130 L3).
 */
describe('#131 — DispatchTransparencyQueryService.getRunDetail build stamp', () => {
  let prisma: PrismaService;
  let query: DispatchTransparencyQueryService;
  const runIds: bigint[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    // onModuleInit() just took the lock for THIS process's real build — clear it so each test can
    // seed its own simulated lock row without colliding.
    await prisma.$executeRawUnsafe('DELETE FROM runtime_lock');
    query = new DispatchTransparencyQueryService(prisma);
  });

  afterEach(async () => {
    await prisma.dispatchRun.deleteMany({ where: { runId: { in: runIds } } });
    runIds.length = 0;
    await prisma.$executeRawUnsafe('DELETE FROM runtime_lock');
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  const seedRun = (buildVersion: bigint | null, buildFingerprint: string | null) =>
    prisma.dispatchRun.create({
      data: {
        trigger: 'CRON',
        status: 'SUCCESS',
        configSnapshot: {},
        buildVersion,
        buildFingerprint,
      },
    });

  const seedLock = (version: number, fingerprint: string) =>
    prisma.$executeRawUnsafe(
      `INSERT INTO runtime_lock (id, version, fingerprint, app_version, migration_head, boot_at, pid, hostname, updated_at)
       VALUES (1, ${version}, '${fingerprint}', '0.0.1', 'head', now(), 1, 'h', now())`,
    );

  it('flags staleBuild when the run predates the current lock version', async () => {
    await seedLock(200, 'currentsha');
    const run = await seedRun(100n, 'stalesha');
    runIds.push(run.runId);

    const detail = await query.getRunDetail(run.runId, { role: 'OPERATIONS_HEAD', zoneId: null });

    expect(detail?.build).toEqual({
      buildVersion: '100',
      buildFingerprint: 'stalesha',
      staleBuild: true,
      currentVersion: '200',
      currentFingerprint: 'currentsha',
    });
  });

  it('does not flag a run at or above the current lock version', async () => {
    await seedLock(200, 'currentsha');
    const run = await seedRun(200n, 'currentsha');
    runIds.push(run.runId);

    const detail = await query.getRunDetail(run.runId, { role: 'OPERATIONS_HEAD', zoneId: null });

    expect(detail?.build?.staleBuild).toBe(false);
  });

  it('returns a null build stamp for a pre-#130 run with no build columns (historical rows)', async () => {
    await seedLock(200, 'currentsha');
    const run = await seedRun(null, null);
    runIds.push(run.runId);

    const detail = await query.getRunDetail(run.runId, { role: 'OPERATIONS_HEAD', zoneId: null });

    expect(detail?.build).toBeNull();
  });
});
