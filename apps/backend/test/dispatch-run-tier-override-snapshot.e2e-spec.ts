import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { DispatchRunService } from '../src/scheduling/dispatch-run.service';

/**
 * Issue 157, Slice 3 — AC-6 (partial): `dispatch_runs.config_snapshot` includes every ACTIVE,
 * unexpired company tier override at run start, so history shows which overrides were live for a
 * given run even after a later sweep expires it or an admin cancels it.
 */
const NS = Date.now();
const NOW = new Date('2026-07-23T06:00:00Z');

describe('Issue 157 Slice 3 — dispatch-run config_snapshot carries active tier overrides (AC-6)', () => {
  let prisma: PrismaService;
  let svc: DispatchRunService;
  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let overrideId: bigint;
  let runId: bigint | null = null;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new DispatchRunService(
      prisma,
      new RecommenderService(prisma, new CandidateSelectionService(prisma)),
      new BatchAssignmentService(prisma),
    );

    zoneId = (await prisma.zone.create({ data: { name: 'Z157snap-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co157snap-' + NS, companyTier: 'SILVER', companyPriorityRank: 'C' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P157snap-' + NS, zoneId } })).plantId;
    const override = await prisma.companyTierOverride.create({
      data: {
        companyId,
        zoneId,
        tier: 'PLATINUM',
        reason: 'AC-6 fixture — must appear in the run config_snapshot',
        expiresAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
        status: 'ACTIVE',
      },
    });
    overrideId = override.id;
  });

  afterAll(async () => {
    if (runId) {
      await prisma.auditLog.deleteMany({ where: { entityType: 'dispatch_run', entityId: runId.toString() } });
      await prisma.dispatchRun.deleteMany({ where: { runId } });
    }
    await prisma.companyTierOverride.deleteMany({ where: { companyId } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it("captures the override in the run's config_snapshot.tierOverrides", async () => {
    await svc.runForActiveZones(NOW);
    const run = await prisma.dispatchRun.findFirstOrThrow({ orderBy: { runId: 'desc' } });
    runId = run.runId;

    const snapshot = run.configSnapshot as { tierOverrides?: Record<string, unknown>[] };
    expect(Array.isArray(snapshot.tierOverrides)).toBe(true);
    const mine = snapshot.tierOverrides!.find((o) => o.id === overrideId.toString());
    expect(mine).toMatchObject({
      companyId: companyId.toString(),
      zoneId: zoneId.toString(),
      tier: 'PLATINUM',
    });
  });
});
