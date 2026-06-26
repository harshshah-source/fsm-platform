import { SoftInactiveCountService } from '../src/reports/soft-inactive-count.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 40 slice 1 — the Soft Inactive Count signal. Per zone, the count of **Eligible Devices**
 * currently silent >24h (`eligible_for_uptime AND is_inactive`); `deficitMode` = count exceeds
 * `thresholdPct × eligibleDeviceCount` (the Recommender's deficit/preventive switch). `recompute`
 * snapshots every zone twice daily; `modeForZone` is the live switch the Recommender consumes. The
 * threshold is configurable (CONTEXT default 2%); the test injects 25% so 4 devices exercise the boundary.
 */
const NS = Date.now();
const NOW = new Date(Date.UTC(2026, 5, 26, 9, 0, 0)); // 09:00 UTC → MORNING capture
const THRESHOLD = 0.25; // 0.25 × 4 eligible = 1.0 boundary

describe('Issue 40 slice 1 — SoftInactiveCountService', () => {
  let prisma: PrismaService;
  let service: SoftInactiveCountService;

  let zoneA: bigint; // 4 eligible, 2 soft-inactive (+1 ineligible-inactive) → DEFICIT
  let zoneC: bigint; // 4 eligible, 1 soft-inactive → PREVENTIVE
  let zoneB: bigint; // no devices
  let plantA: bigint;
  let plantC: bigint;
  let devSeq = 9_400_000n;
  const devices: bigint[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new SoftInactiveCountService(prisma, THRESHOLD);

    zoneA = (await prisma.zone.create({ data: { name: 'Z-si-A-' + NS } })).zoneId;
    zoneC = (await prisma.zone.create({ data: { name: 'Z-si-C-' + NS } })).zoneId;
    zoneB = (await prisma.zone.create({ data: { name: 'Z-si-B-' + NS } })).zoneId;
    plantA = (await prisma.plant.create({ data: { name: 'P-si-A-' + NS, zoneId: zoneA } })).plantId;
    plantC = (await prisma.plant.create({ data: { name: 'P-si-C-' + NS, zoneId: zoneC } })).plantId;

    // zoneA: 4 eligible (2 inactive) + 1 ineligible-but-inactive (must be excluded from both counts)
    await dev(plantA, true, true);
    await dev(plantA, true, true);
    await dev(plantA, true, false);
    await dev(plantA, true, false);
    await dev(plantA, false, true); // ineligible
    // zoneC: 4 eligible, 1 inactive
    await dev(plantC, true, true);
    await dev(plantC, true, false);
    await dev(plantC, true, false);
    await dev(plantC, true, false);
  });

  async function dev(plantId: bigint, eligible: boolean, inactive: boolean): Promise<void> {
    const deviceId = devSeq++;
    devices.push(deviceId);
    await prisma.device.create({ data: { deviceId, deviceType: 'GPS-X' } });
    await prisma.deviceState.create({
      data: { deviceId, eligibleForUptime: eligible, isInactive: inactive, plantId, computedAt: NOW },
    });
  }

  afterAll(async () => {
    await prisma.softInactiveCountHistory.deleteMany({ where: { zoneId: { in: [zoneA, zoneB, zoneC] } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: devices } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: devices } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [plantA, plantC] } } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: [zoneA, zoneB, zoneC] } } });
    await prisma.onModuleDestroy();
  });

  it('modeForZone: DEFICIT when soft-inactive exceeds the threshold, else PREVENTIVE', async () => {
    expect(await service.modeForZone(zoneA, NOW)).toBe('DEFICIT'); // 2 > 0.25×4 = 1.0
    expect(await service.modeForZone(zoneC, NOW)).toBe('PREVENTIVE'); // 1 ≤ 1.0
    expect(await service.modeForZone(zoneB, NOW)).toBe('PREVENTIVE'); // no devices
  });

  it('recompute snapshots every zone with counts, deficit flag, threshold and period', async () => {
    const result = await service.recompute(NOW);
    expect(result.zones).toBeGreaterThanOrEqual(3);

    const a = await latest(zoneA);
    expect(a.softInactiveCount).toBe(2);
    expect(a.eligibleDeviceCount).toBe(4); // the ineligible-inactive device is excluded
    expect(a.deficitMode).toBe(true);
    expect(Number(a.thresholdPct)).toBe(THRESHOLD);
    expect(a.period).toBe('MORNING');

    const c = await latest(zoneC);
    expect(c.softInactiveCount).toBe(1);
    expect(c.deficitMode).toBe(false);

    const b = await latest(zoneB);
    expect(b.softInactiveCount).toBe(0);
    expect(b.eligibleDeviceCount).toBe(0);
    expect(b.deficitMode).toBe(false);
  });

  it('labels an afternoon capture', async () => {
    const pm = new Date(Date.UTC(2026, 5, 26, 15, 0, 0));
    await service.recompute(pm);
    expect((await latest(zoneA)).period).toBe('AFTERNOON');
  });

  const latest = (zoneId: bigint) =>
    prisma.softInactiveCountHistory.findFirstOrThrow({ where: { zoneId }, orderBy: { capturedAt: 'desc' } });
});
