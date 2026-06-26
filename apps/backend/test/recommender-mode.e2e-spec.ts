import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 40 slice 2 — the Soft Inactive Count drives the Recommender's mode (AC#2). `runForZone` reads
 * `SoftInactiveCountService.modeForZone` and reports the active DEFICIT/PREVENTIVE mode on its
 * `RunSummary`. With the default 2% threshold, a single eligible+inactive device (1 > 0.02) → DEFICIT;
 * an all-active zone → PREVENTIVE. (Full preventive-mode scoring re-prioritisation is follow-up #72.)
 */
const NS = Date.now();
const NOW = new Date(Date.UTC(2026, 5, 26, 8, 0, 0));

describe('Issue 40 slice 2 — RecommenderService mode switch', () => {
  let prisma: PrismaService;
  let recommender: RecommenderService;

  let zoneDeficit: bigint;
  let zonePreventive: bigint;
  let plantD: bigint;
  let plantP: bigint;
  const devices: bigint[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    recommender = new RecommenderService(prisma, new CandidateSelectionService(prisma));

    zoneDeficit = (await prisma.zone.create({ data: { name: 'Z-rm-D-' + NS } })).zoneId;
    zonePreventive = (await prisma.zone.create({ data: { name: 'Z-rm-P-' + NS } })).zoneId;
    plantD = (await prisma.plant.create({ data: { name: 'P-rm-D-' + NS, zoneId: zoneDeficit } })).plantId;
    plantP = (await prisma.plant.create({ data: { name: 'P-rm-P-' + NS, zoneId: zonePreventive } })).plantId;

    await dev(plantD, true, true); // eligible + inactive → soft-inactive
    await dev(plantP, true, false); // eligible, active
  });

  async function dev(plantId: bigint, eligible: boolean, inactive: boolean): Promise<void> {
    const deviceId = BigInt(9_401_000) + BigInt(devices.length);
    devices.push(deviceId);
    await prisma.device.create({ data: { deviceId, deviceType: 'GPS-X' } });
    await prisma.deviceState.create({ data: { deviceId, eligibleForUptime: eligible, isInactive: inactive, plantId, computedAt: NOW } });
  }

  afterAll(async () => {
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: devices } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: devices } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [plantD, plantP] } } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: [zoneDeficit, zonePreventive] } } });
    await prisma.onModuleDestroy();
  });

  it('a zone over the Soft-Inactive threshold runs in DEFICIT mode', async () => {
    const summary = await recommender.runForZone(zoneDeficit, { now: NOW });
    expect(summary.mode).toBe('DEFICIT');
  });

  it('an all-active zone runs in PREVENTIVE mode', async () => {
    const summary = await recommender.runForZone(zonePreventive, { now: NOW });
    expect(summary.mode).toBe('PREVENTIVE');
  });
});
