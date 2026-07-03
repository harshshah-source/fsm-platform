import {
  AutoPlantHealthService,
  type AutoPlantProbe,
} from '../src/ingestion/autoplant/health.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Phase 4/8 — AutoPlant integration health surface (blueprint §9). Reports source connectivity
 * (configured vs reachable) and the freshness of the last master-sync + snapshot, computed from the
 * FSM run tables — no VPN needed for the freshness paths. The source probe is faked so all three
 * connectivity branches are deterministic without live MySQL.
 */
const okProbe: AutoPlantProbe = { isConfigured: () => true, ping: async () => ({ ok: true, vehicleRows: 42 }) };
const unsetProbe: AutoPlantProbe = {
  isConfigured: () => false,
  ping: async () => {
    throw new Error('should not ping when unconfigured');
  },
};
const downProbe: AutoPlantProbe = {
  isConfigured: () => true,
  ping: async () => {
    throw new Error('ETIMEDOUT 10.0.0.25:3306');
  },
};

describe('Phase 4 — AutoPlantHealthService', () => {
  let prisma: PrismaService;
  const createdMaster: bigint[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
  });

  afterEach(async () => {
    if (createdMaster.length > 0) {
      await prisma.masterSyncRun.deleteMany({ where: { runId: { in: createdMaster } } });
      createdMaster.length = 0;
    }
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it('reports the source as not-configured (env unset) without pinging', async () => {
    const service = new AutoPlantHealthService(prisma, unsetProbe);
    const health = await service.check();
    expect(health.source.configured).toBe(false);
    expect(health.source.connected).toBe(false);
    expect(health.source.error).toMatch(/configured/i);
  });

  it('reports connected + vehicle row count when the probe succeeds', async () => {
    const service = new AutoPlantHealthService(prisma, okProbe);
    const health = await service.check();
    expect(health.source).toMatchObject({ configured: true, connected: true, vehicleRows: 42 });
  });

  it('reports configured-but-unreachable when the probe throws (VPN down)', async () => {
    const service = new AutoPlantHealthService(prisma, downProbe);
    const health = await service.check();
    expect(health.source.configured).toBe(true);
    expect(health.source.connected).toBe(false);
    expect(health.source.error).toMatch(/ETIMEDOUT/);
  });

  it('computes master-sync freshness (age + last status) from the run table', async () => {
    const now = new Date('2026-07-03T12:00:00Z');
    const finishedAt = new Date('2026-07-03T10:30:00Z'); // 90 minutes before `now`
    const run = await prisma.masterSyncRun.create({
      data: { status: 'SUCCESS', finishedAt },
    });
    createdMaster.push(run.runId);

    const service = new AutoPlantHealthService(prisma, okProbe);
    const health = await service.check(now);

    expect(health.masterSync.lastStatus).toBe('SUCCESS');
    expect(health.masterSync.lastAt?.toISOString()).toBe(finishedAt.toISOString());
    expect(health.masterSync.ageMinutes).toBe(90);
    expect(health.checkedAt.toISOString()).toBe(now.toISOString());
  });
});
