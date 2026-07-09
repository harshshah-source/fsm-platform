import { PrismaService } from '../src/prisma/prisma.service';
import { seedMockEngineers } from '../prisma/seed-mock-engineers';

/**
 * Phase B — the dev/test mock-SE seed. Proves it places SEs on a zone's highest-inactive plants
 * (in-zone), wires a ZM, and is idempotent on re-run.
 */
const NS = Date.now();

describe('seedMockEngineers (dev/test mock SE workforce)', () => {
  let prisma: PrismaService;
  let zoneId: bigint;
  let companyId: bigint;
  let plantBusy: bigint; // most inactive
  let plantSome: bigint; // some inactive
  let plantIdle: bigint; // no inactive → must NOT be covered
  const deviceIds: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    zoneId = (await prisma.zone.create({ data: { name: 'Z-seed-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-seed-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantBusy = (await prisma.plant.create({ data: { name: 'P-busy-' + NS, zoneId } })).plantId;
    plantSome = (await prisma.plant.create({ data: { name: 'P-some-' + NS, zoneId } })).plantId;
    plantIdle = (await prisma.plant.create({ data: { name: 'P-idle-' + NS, zoneId } })).plantId;

    const mk = async (plantId: bigint, n: number) => {
      for (let i = 0; i < n; i++) {
        const deviceId = String(13_100_000_000 + (NS % 100_000) + deviceIds.length);
        deviceIds.push(deviceId);
        await prisma.device.create({ data: { deviceId } });
        await prisma.deviceState.create({
          data: { deviceId, isInactive: true, slaBucket: 'CRITICAL', eligibleForUptime: true, hasOpenFailureCycle: false, plantId, companyId, computedAt: new Date() },
        });
      }
    };
    await mk(plantBusy, 5);
    await mk(plantSome, 2);
    // plantIdle: no inactive device_states
  });

  afterAll(async () => {
    await prisma.seCoverage.deleteMany({ where: { plant: { zoneId } } });
    await prisma.engineerMaster.deleteMany({ where: { zoneId } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.zone.update({ where: { zoneId }, data: { zonalManagerUserId: null } });
    await prisma.user.deleteMany({ where: { zoneId } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [plantBusy, plantSome, plantIdle] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('seeds a ZM + SEs covering only the inactive plants, in-zone', async () => {
    const summary = await seedMockEngineers(prisma, [{ zoneId, seCount: 2, dailyCapacity: 10 }]);

    expect(summary.zms).toBe(1);
    expect(summary.engineers).toBe(2);
    expect(summary.coverageRows).toBe(2); // busy + some; idle excluded

    // ZM wired to the zone.
    const zone = await prisma.zone.findUniqueOrThrow({ where: { zoneId } });
    expect(zone.zonalManagerUserId).not.toBeNull();
    const zm = await prisma.user.findUniqueOrThrow({ where: { userId: zone.zonalManagerUserId! } });
    expect(zm.role).toBe('ZONAL_MANAGER');

    // Coverage is exactly the two inactive plants (idle plant not covered), all in-zone.
    const coverage = await prisma.seCoverage.findMany({ where: { plant: { zoneId } }, include: { plant: true } });
    const coveredPlantIds = coverage.map((c) => c.plantId).sort();
    expect(coveredPlantIds).toEqual([plantBusy, plantSome].sort());
    expect(coverage.every((c) => c.plant.zoneId === zoneId)).toBe(true);

    // Engineers are SERVICE_ENGINEER, active, in-zone, positive capacity.
    const engineers = await prisma.engineerMaster.findMany({ where: { zoneId } });
    expect(engineers).toHaveLength(2);
    expect(engineers.every((e) => e.isActive && e.dailyCapacity === 10 && e.zoneId === zoneId)).toBe(true);
  });

  it('is idempotent — a re-run creates no new rows', async () => {
    const again = await seedMockEngineers(prisma, [{ zoneId, seCount: 2, dailyCapacity: 10 }]);
    expect(again.coverageRows).toBe(0); // nothing new mapped
    const engineers = await prisma.engineerMaster.count({ where: { zoneId } });
    const coverage = await prisma.seCoverage.count({ where: { plant: { zoneId } } });
    const users = await prisma.user.count({ where: { zoneId } });
    expect(engineers).toBe(2);
    expect(coverage).toBe(2);
    expect(users).toBe(3); // 2 SE + 1 ZM
  });
});
