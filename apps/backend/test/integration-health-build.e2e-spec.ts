import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AutoPlantHealthService, type AutoPlantProbe } from '../src/ingestion/autoplant/health.service';
import { getBuildInfo } from '../src/build-info/build-info';
import { PrismaService } from '../src/prisma/prisma.service';

const okProbe: AutoPlantProbe = { isConfigured: () => true, ping: async () => ({ ok: true, vehicleRows: 1 }) };

/**
 * #130 L3/L5 exposure — the integration-health surface reports the current runtime-lock build, flags
 * runs/recomputes produced by a build below that mark (staleBuild), and returns the last-N recompute
 * history with the canary swing flagged. This is the API the admin integration-health page consumes.
 */
describe('#130 — integration-health build attribution + recompute history', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit(); // takes the runtime lock for this build
  });
  afterEach(async () => {
    await prisma.$executeRawUnsafe('DELETE FROM device_state_recomputes');
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('reports the current runtime-lock version/fingerprint', async () => {
    const health = await new AutoPlantHealthService(prisma, okProbe).check();
    const build = getBuildInfo();
    expect(health.runtimeLock.version).toBe(String(build.version));
    expect(health.runtimeLock.fingerprint).toBe(build.fingerprint);
  });

  it('returns the last-N recompute history with counts, build, and the canary swing flag', async () => {
    // Two ledger rows: an older baseline, then a big eligible jump → the newer row is a swing.
    await prisma.deviceStateRecompute.create({
      data: {
        computedAt: new Date(Date.now() - 7_200_000),
        eligibleCount: 1000, inactiveCount: 0, departedCount: 0, totalCount: 1000,
        buildVersion: BigInt(getBuildInfo().version), buildFingerprint: getBuildInfo().fingerprint, trigger: 'cron',
      },
    });
    await prisma.deviceStateRecompute.create({
      data: {
        computedAt: new Date(Date.now() - 3_600_000),
        eligibleCount: 2000, inactiveCount: 0, departedCount: 0, totalCount: 2000, // +100% swing
        buildVersion: BigInt(getBuildInfo().version), buildFingerprint: getBuildInfo().fingerprint, trigger: 'cron',
      },
    });

    const health = await new AutoPlantHealthService(prisma, okProbe).check();
    expect(health.recomputes.length).toBeGreaterThanOrEqual(2);
    const newest = health.recomputes[0];
    expect(newest.eligibleCount).toBe(2000);
    expect(newest.trigger).toBe('cron');
    expect(newest.swing).toBe(true); // +100% exceeds the 5% threshold
    expect(newest.swingPct).not.toBeNull();
    // The older baseline row has no prior → not a swing.
    expect(health.recomputes[1].swing).toBe(false);
  });

  it('flags a recompute produced by a build older than the lock as staleBuild', async () => {
    await prisma.deviceStateRecompute.create({
      data: {
        computedAt: new Date(),
        eligibleCount: 10, inactiveCount: 0, departedCount: 0, totalCount: 10,
        buildVersion: 1n, buildFingerprint: 'ancientbuild', trigger: 'cron', // v1 << the lock
      },
    });
    const health = await new AutoPlantHealthService(prisma, okProbe).check();
    const stale = health.recomputes.find((r) => r.buildFingerprint === 'ancientbuild');
    expect(stale?.staleBuild).toBe(true);
  });
});
