import { AuditService } from '../src/audit/audit.service';
import { DeviceStateService } from '../src/device-state/device-state.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { SettingsService } from '../src/settings/settings.service';

/**
 * Issue 05, slice 3 — DeviceStateService upserts `device_states` from the latest snapshot (AC#2).
 *
 * For each device it reads the latest `raw_device_snapshots` ping, derives
 * `inactivity_hours = now − latest_gps_datetime` (clamped ≥0), sets `is_inactive` against the
 * configurable 24h threshold, stamps the stored `sla_bucket` via the pure classifier, and
 * denormalises vehicle/plant/company off the device's current fitment. One upserted row per device.
 *
 * Test assets live in a 9_05x namespace and are torn down per file against the persistent local DB.
 */
const INACTIVE_DEV = 9_051_001n;
const ACTIVE_DEV = 9_051_002n;

describe('Issue 05 slice 3 — DeviceStateService.recompute', () => {
  let prisma: PrismaService;
  let service: DeviceStateService;
  let companyId: bigint;
  let plantId: bigint;
  let zoneId: bigint;
  let vehicleId: bigint;
  let runId: bigint;

  // A fixed "now" so inactivity-hours maths is deterministic.
  const NOW = new Date(Date.UTC(2026, 5, 20, 12, 0, 0));
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    const settings = new SettingsService(prisma, new AuditService(prisma));
    await settings.seedDefaults();
    service = new DeviceStateService(prisma, settings);

    const zone = await prisma.zone.create({ data: { name: 'Z-slice3-' + Date.now() } });
    zoneId = zone.zoneId;
    const company = await prisma.company.create({
      data: { name: 'Co-slice3', companyTier: 'GOLD', companyPriorityRank: 'B' },
    });
    companyId = company.companyId;
    const plant = await prisma.plant.create({ data: { name: 'P-slice3', zoneId } });
    plantId = plant.plantId;
    const vehicle = await prisma.vehicle.create({
      data: { vehicleNo: 'VH-slice3-' + Date.now(), plantId, companyId },
    });
    vehicleId = vehicle.vehicleId;
    const run = await prisma.snapshotRun.create({ data: { status: 'SUCCESS' } });
    runId = run.runId;

    for (const deviceId of [INACTIVE_DEV, ACTIVE_DEV]) {
      await prisma.device.create({ data: { deviceId, currentVehicleId: vehicleId } });
    }
    // INACTIVE: last ping 30h ago → CRITICAL (24–48h), is_inactive.
    await prisma.rawDeviceSnapshot.create({
      data: { runId, deviceId: INACTIVE_DEV, gpsDatetime: hoursAgo(30) },
    });
    // ACTIVE: last ping 1h ago → no bucket, not inactive.
    await prisma.rawDeviceSnapshot.create({
      data: { runId, deviceId: ACTIVE_DEV, gpsDatetime: hoursAgo(1) },
    });
  });

  afterAll(async () => {
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: [INACTIVE_DEV, ACTIVE_DEV] } } });
    await prisma.rawDeviceSnapshot.deleteMany({ where: { runId } });
    await prisma.device.deleteMany({ where: { deviceId: { in: [INACTIVE_DEV, ACTIVE_DEV] } } });
    await prisma.snapshotRun.deleteMany({ where: { runId } });
    await prisma.vehicle.deleteMany({ where: { vehicleId } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('upserts an inactive device with the right bucket and denormalised plant/company', async () => {
    await service.recompute(NOW);

    const state = await prisma.deviceState.findUnique({ where: { deviceId: INACTIVE_DEV } });
    expect(state).not.toBeNull();
    expect(state!.isInactive).toBe(true);
    expect(state!.slaBucket).toBe('CRITICAL');
    expect(Number(state!.inactivityHours)).toBeCloseTo(30, 3);
    expect(state!.latestGpsDatetime?.toISOString()).toBe(hoursAgo(30).toISOString());
    expect(state!.plantId).toBe(plantId);
    expect(state!.companyId).toBe(companyId);
    expect(state!.vehicleId).toBe(vehicleId);
  });

  it('upserts an active device as not-inactive with no bucket', async () => {
    await service.recompute(NOW);

    const state = await prisma.deviceState.findUnique({ where: { deviceId: ACTIVE_DEV } });
    expect(state).not.toBeNull();
    expect(state!.isInactive).toBe(false);
    expect(state!.slaBucket).toBeNull();
  });

  it('is an upsert — a second recompute updates in place, not a duplicate', async () => {
    await service.recompute(NOW);
    await service.recompute(NOW);

    const count = await prisma.deviceState.count({ where: { deviceId: INACTIVE_DEV } });
    expect(count).toBe(1);
  });
});
