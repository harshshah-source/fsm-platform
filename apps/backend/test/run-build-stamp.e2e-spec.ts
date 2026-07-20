import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getBuildInfo } from '../src/build-info/build-info';
import { PrismaService } from '../src/prisma/prisma.service';
import { MasterSyncRunService } from '../src/ingestion/autoplant/master-sync-run.service';
import { SnapshotRunService } from '../src/ingestion/snapshot-run.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { DispatchRunService } from '../src/scheduling/dispatch-run.service';

/**
 * #130 L3 — every pipeline run is attributed to the build that produced it: `build_version` +
 * `build_fingerprint` stamped at run creation from build-info. This is what lets a stale run be
 * flagged after the fact (build_version < runtime_lock.version) even when L1 didn't catch the boot.
 */
describe('#130 L3 — run ledgers stamped with the producing build', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  // The `_test` DB persists across runs; a leftover RUNNING row would trip the single-in-flight
  // guard at startRun. Neutralize any in-flight master/snapshot run before each test.
  beforeEach(async () => {
    await prisma.masterSyncRun.updateMany({ where: { status: 'RUNNING' }, data: { status: 'FAILED', finishedAt: new Date() } });
    await prisma.snapshotRun.updateMany({ where: { status: 'RUNNING' }, data: { status: 'FAILED', finishedAt: new Date() } });
  });

  const build = getBuildInfo();

  it('stamps a master_sync_runs row at startRun', async () => {
    const { runId } = await new MasterSyncRunService(prisma).startRun();
    const row = await prisma.masterSyncRun.findUniqueOrThrow({ where: { runId } });
    expect(row.buildVersion).toBe(BigInt(build.version));
    expect(row.buildFingerprint).toBe(build.fingerprint);
    await prisma.masterSyncRun.update({ where: { runId }, data: { status: 'SUCCESS', finishedAt: new Date() } });
  });

  it('stamps a snapshot_runs row at startRun', async () => {
    const { runId } = await new SnapshotRunService(prisma).startRun();
    const row = await prisma.snapshotRun.findUniqueOrThrow({ where: { runId } });
    expect(row.buildVersion).toBe(BigInt(build.version));
    expect(row.buildFingerprint).toBe(build.fingerprint);
    await prisma.snapshotRun.update({ where: { runId }, data: { status: 'SUCCESS', finishedAt: new Date() } });
  });

  it('stamps a dispatch_runs row at run creation', async () => {
    const svc = new DispatchRunService(
      prisma,
      new RecommenderService(prisma, new CandidateSelectionService(prisma)),
      new BatchAssignmentService(prisma),
    );
    const summary = await svc.runForActiveZones(new Date());
    const row = await prisma.dispatchRun.findUniqueOrThrow({ where: { runId: BigInt(summary.runId) } });
    expect(row.buildVersion).toBe(BigInt(build.version));
    expect(row.buildFingerprint).toBe(build.fingerprint);
  });
});
