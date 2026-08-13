import { AuditService } from '../src/audit/audit.service';
import { DeviceStateService } from '../src/device-state/device-state.service';
import { classifySlaBucket } from '../src/device-state/sla-bucket';
import { SnapshotIngestionService } from '../src/ingestion/snapshot-ingestion.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { SettingsService } from '../src/settings/settings.service';

/**
 * Issue 05 slice 3 / R4-B — DeviceStateService derives `device_states` set-based (AC#2).
 *
 * Post-R4, `latest_gps_datetime` is maintained at INGEST (`SnapshotIngestionService.ingestChunk`), so
 * this test seeds through that real path, then `recompute` derives — clamped `inactivity_hours`,
 * `is_inactive` vs the configurable 24h threshold, the stored `sla_bucket` (SQL CASE kept in lockstep
 * with the TS classifier), eligibility, and the denormalised plant/company/vehicle — with no telemetry
 * scan. Test assets live in a 9_05x namespace and are torn down per file against the persistent local DB.
 */
const INACTIVE_DEV = String(9_051_001n);
const ACTIVE_DEV = String(9_051_002n);

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
    // Seed latest_gps_datetime the production way — ingest maintains it, recompute derives from it.
    // INACTIVE: last ping 30h ago → CRITICAL (24–48h), is_inactive. ACTIVE: 1h ago → no bucket.
    const ingest = new SnapshotIngestionService(prisma);
    await ingest.ingestChunk(
      runId,
      [
        { deviceId: INACTIVE_DEV, gpsDatetime: hoursAgo(30), lat: 12.97, lon: 77.59 },
        { deviceId: ACTIVE_DEV, gpsDatetime: hoursAgo(1), lat: 12.97, lon: 77.59 },
      ],
      NOW,
    );
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

  it('the SQL sla_bucket CASE matches classifySlaBucket across every band boundary', async () => {
    // Sample each band and its just-below-boundary neighbour so any drift between the SQL CASE and the
    // TS classifier surfaces. 3h → ACTIVE(null); 4/8/12/24/48/72/120/168 land on band edges.
    const hours = [3, 4, 7.9, 8, 11.9, 12, 23.9, 24, 47.9, 48, 71.9, 72, 119.9, 120, 167.9, 168, 240];
    const ids = hours.map((h) => `9_051_9${String(Math.round(h * 10)).padStart(4, '0')}`);
    try {
      await prisma.device.createMany({
        data: ids.map((deviceId) => ({ deviceId })),
        skipDuplicates: true,
      });
      const parityRun = await prisma.snapshotRun.create({ data: { status: 'SUCCESS' } });
      const ingest = new SnapshotIngestionService(prisma);
      await ingest.ingestChunk(
        parityRun.runId,
        hours.map((h, i) => ({ deviceId: ids[i], gpsDatetime: hoursAgo(h), lat: 1, lon: 1 })),
        NOW,
      );

      await service.recompute(NOW);

      const states = await prisma.deviceState.findMany({ where: { deviceId: { in: ids } } });
      const byId = new Map(states.map((s) => [s.deviceId, s.slaBucket]));
      for (let i = 0; i < hours.length; i++) {
        expect(byId.get(ids[i]) ?? null).toBe(classifySlaBucket(hours[i]));
      }

      await prisma.deviceState.deleteMany({ where: { deviceId: { in: ids } } });
      await prisma.rawDeviceSnapshot.deleteMany({ where: { runId: parityRun.runId } });
      await prisma.snapshotRun.deleteMany({ where: { runId: parityRun.runId } });
    } finally {
      await prisma.device.deleteMany({ where: { deviceId: { in: ids } } });
    }
  });

  /**
   * #230 — the guard. Ageing is a function of wall-clock time, so it is correct for a device that was
   * READ and found silent, and fabrication for a device the read never reached. On 2026-08-10 snapshot
   * run 153 aborted after 2,610 of 27,032 devices; this pass aged the 24,422 it never saw into
   * `is_inactive`, and ticket creation opened 3,439 Failure Cycles on devices nobody had checked.
   *
   * `skipDerivation` is the refusal. It is deliberately all-or-nothing: the ingest dedupes unchanged
   * pings away, so "no ping row this run" cannot tell *not read* from *read and silent*, and a
   * per-device coverage filter built on that would be wrong in exactly the dangerous direction.
   */
  it('#230 — skipDerivation freezes the fleet picture instead of ageing devices the read never saw', async () => {
    // Establish a real derived state first, then advance the clock a long way.
    await service.recompute(NOW);
    const before = await prisma.deviceState.findUniqueOrThrow({ where: { deviceId: ACTIVE_DEV } });
    expect(before.isInactive).toBe(false); // pinged 1h ago

    const muchLater = new Date(NOW.getTime() + 500 * 3_600_000); // +500h: would be LONG_PENDING
    const result = await service.recompute(muchLater, 'api', { skipDerivation: true });

    expect(result).toEqual({ upserted: 0, derived: false });
    const after = await prisma.deviceState.findUniqueOrThrow({ where: { deviceId: ACTIVE_DEV } });
    // The device did NOT silently become inactive on evidence nobody gathered.
    expect(after.isInactive).toBe(false);
    expect(after.slaBucket).toBe(before.slaBucket);
    expect(Number(after.inactivityHours)).toBeCloseTo(Number(before.inactivityHours), 4);
    // computed_at deliberately lags — that IS the signal the picture is not current.
    expect(after.computedAt).toEqual(before.computedAt);

    // And the same clock WITHOUT the guard does age it — proving the test isn't passing vacuously.
    await service.recompute(muchLater);
    const aged = await prisma.deviceState.findUniqueOrThrow({ where: { deviceId: ACTIVE_DEV } });
    expect(aged.isInactive).toBe(true);

    await service.recompute(NOW); // restore for any later assertions
  });

  it('#230 — skipDerivation still creates a row for a brand-new device (that is not a derivation)', async () => {
    const NEW_DEV = String(9_051_099n);
    await prisma.device.create({ data: { deviceId: NEW_DEV } });
    try {
      await service.recompute(NOW, 'api', { skipDerivation: true });
      const row = await prisma.deviceState.findUnique({ where: { deviceId: NEW_DEV } });
      expect(row).not.toBeNull();
      // Never ping-ed and never derived: it must not be asserted inactive either.
      expect(row!.isInactive).toBe(false);
    } finally {
      await prisma.deviceState.deleteMany({ where: { deviceId: NEW_DEV } });
      await prisma.device.deleteMany({ where: { deviceId: NEW_DEV } });
    }
  });
});
