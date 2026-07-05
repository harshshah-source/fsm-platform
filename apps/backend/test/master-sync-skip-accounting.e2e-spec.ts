import { vi } from 'vitest';
import { MasterSyncRunService } from '../src/ingestion/autoplant/master-sync-run.service';
import {
  MasterSyncService,
  type MasterSyncSource,
  type PlantZoneResolver,
} from '../src/ingestion/autoplant/master-sync.service';
import type {
  MstCompanyRow,
  MstPlantRow,
  MstTransporterRow,
  VehicleMasterMasterRow,
  MasterSyncScope,
} from '../src/ingestion/autoplant/master-mapping';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 97 Slice 4 (review A5) — itemised master-sync skip accounting. Skips used to be bare
 * counters ("vehicles: {skipped: 3200}") with the reason only in code comments; the `< 100`-row
 * source cap makes after-the-fact investigation painful. Now every skip site (a) splits the
 * `entity_stats` counter per reason and (b) writes a `master_sync_rejects` row
 * `(run_id, entity, source_key, reason)` so an operator can enumerate "which 3,200 and why" with
 * one indexed query. Reject writing is best-effort — it never fails the sync.
 *
 * Reason vocabulary (one code per existing skip site; no new business rules):
 *   plants     OUT_OF_SCOPE_STATUS · ZONE_UNRESOLVED
 *   companies  NO_INSCOPE_PLANT
 *   vehicles   PLANT_NOT_SYNCED · COMPANY_NOT_SYNCED
 *   devices    VEHICLE_NOT_SYNCED · NO_FITTED_DEVICE
 */
describe('Issue 97 Slice 4 — itemised master-sync skip accounting', () => {
  let prisma: PrismaService;
  let runService: MasterSyncRunService;
  let zoneId: bigint;
  const runIds: bigint[] = [];

  const SRC_CO = 910001n; // owns the in-scope plant → created
  const SRC_GHOST_CO = 910002n; // referenced only by the INACTIVE plant → NO_INSCOPE_PLANT
  const SRC_PLANT = 910011n; // ACTIVE + resolvable → synced
  const SRC_INACTIVE_PLANT = 910012n; // INACTIVE → OUT_OF_SCOPE_STATUS
  const SRC_UNZONED_PLANT = 910013n; // ACTIVE but resolver defers it → ZONE_UNRESOLVED
  const V_OK = 'ZZS4OK0001'; // fully synced, fitted device
  const V_NOPLANT = 'ZZS4NP0002'; // hangs off the INACTIVE plant → PLANT_NOT_SYNCED
  const V_NOCO = 'ZZS4NC0003'; // in-scope plant but ghost company → COMPANY_NOT_SYNCED
  const V_NODEV = 'ZZS4ND0004'; // synced vehicle, no fitted device → NO_FITTED_DEVICE
  const DEV_OK = '0899100000000001';
  const DEV_ORPHAN = '0899100000000002'; // fitted on V_NOPLANT → VEHICLE_NOT_SYNCED

  const scope: MasterSyncScope = { plantStatuses: ['ACTIVE'] };

  const companies: MstCompanyRow[] = [
    { company_id: Number(SRC_CO), company_name: 'Skip Acct Cement', company_type: 'NA', status: 'ACTIVE' },
    { company_id: Number(SRC_GHOST_CO), company_name: 'Skip Acct Ghost', company_type: 'NA', status: 'ACTIVE' },
  ];
  const transporters: MstTransporterRow[] = [];
  const plant = (over: Partial<MstPlantRow>): MstPlantRow => ({
    plant_id: 0,
    company_id: Number(SRC_CO),
    plant_name: 'Skip Acct Plant',
    zone_id: 2039,
    zone_name: 'South India',
    region_id: null,
    region_name: null,
    plant_state: 'Andhra Pradesh',
    plant_district: 'Kadapa',
    master_plant_id: null,
    master_plant_code: null,
    status: 'ACTIVE',
    ...over,
  });
  const plants: MstPlantRow[] = [
    plant({ plant_id: Number(SRC_PLANT) }),
    plant({ plant_id: Number(SRC_INACTIVE_PLANT), company_id: Number(SRC_GHOST_CO), status: 'INACTIVE' }),
    plant({ plant_id: Number(SRC_UNZONED_PLANT) }),
  ];
  const vehicle = (over: Partial<VehicleMasterMasterRow>): VehicleMasterMasterRow => ({
    vehicle_no: V_OK,
    device_id: DEV_OK,
    plant_id: Number(SRC_PLANT),
    company_id: Number(SRC_CO),
    transporter_id: null,
    device_type: 'V5',
    deployment_status: 'DEPLOYED',
    ...over,
  });
  const vehicleMasters: VehicleMasterMasterRow[] = [
    vehicle({}),
    vehicle({ vehicle_no: V_NOPLANT, device_id: DEV_ORPHAN, plant_id: Number(SRC_INACTIVE_PLANT), company_id: Number(SRC_GHOST_CO) }),
    vehicle({ vehicle_no: V_NOCO, device_id: null, company_id: Number(SRC_GHOST_CO) }),
    vehicle({ vehicle_no: V_NODEV, device_id: null }),
  ];

  const source: MasterSyncSource = {
    readCompanies: async () => companies,
    readTransporters: async () => transporters,
    readPlants: async () => plants,
    readVehicleMasters: async () => vehicleMasters,
  };

  // R6 seam: resolves every plant except the deliberately-unmappable one.
  const zoneResolver: PlantZoneResolver = {
    resolve: async (p) => (p.plant_id === Number(SRC_UNZONED_PLANT) ? null : { zoneId, districtId: null }),
  };

  const makeService = (): MasterSyncService =>
    new MasterSyncService(prisma, runService, source, zoneResolver, scope);

  const cleanup = async (): Promise<void> => {
    await prisma.device.deleteMany({ where: { deviceId: { in: [DEV_OK, DEV_ORPHAN] } } });
    await prisma.vehicle.deleteMany({ where: { vehicleNo: { in: [V_OK, V_NOPLANT, V_NOCO, V_NODEV] } } });
    await prisma.plant.deleteMany({
      where: { sourcePlantId: { in: [SRC_PLANT, SRC_INACTIVE_PLANT, SRC_UNZONED_PLANT] } },
    });
    await prisma.company.deleteMany({ where: { sourceCompanyId: { in: [SRC_CO, SRC_GHOST_CO] } } });
    await prisma.masterSyncRun.deleteMany({ where: { status: 'RUNNING' } });
    if (runIds.length > 0) {
      await prisma.masterSyncReject.deleteMany({ where: { runId: { in: runIds } } });
      await prisma.masterSyncRun.deleteMany({ where: { runId: { in: runIds } } });
      runIds.length = 0;
    }
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    runService = new MasterSyncRunService(prisma);
    const zone = await prisma.zone.create({ data: { name: `S4_TEST_ZONE_${Date.now()}` } });
    zoneId = zone.zoneId;
    await cleanup();
  });

  afterEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('itemises a skipped out-of-scope plant: per-reason counter + a master_sync_rejects row', async () => {
    const result = await makeService().sync();
    runIds.push(result.runId);
    expect(result.status).toBe('SUCCESS');

    // Counter splits by reason (total `skipped` still counts both plant skip sites).
    expect(result.stats.plants.skippedByReason?.OUT_OF_SCOPE_STATUS).toBe(1);

    // And the skipped natural key is enumerable via one indexed query.
    const rejects = await prisma.masterSyncReject.findMany({
      where: { runId: result.runId, entity: 'plants', reason: 'OUT_OF_SCOPE_STATUS' },
    });
    expect(rejects).toHaveLength(1);
    expect(rejects[0].sourceKey).toBe(String(SRC_INACTIVE_PLANT));
  });

  it('itemises a zone-unresolvable plant as ZONE_UNRESOLVED (R6 deferral)', async () => {
    const result = await makeService().sync();
    runIds.push(result.runId);

    expect(result.stats.plants.skippedByReason?.ZONE_UNRESOLVED).toBe(1);
    expect(result.stats.plants.skipped).toBe(2); // total still counts both plant skip sites

    const rejects = await prisma.masterSyncReject.findMany({
      where: { runId: result.runId, entity: 'plants', reason: 'ZONE_UNRESOLVED' },
    });
    expect(rejects.map((r) => r.sourceKey)).toEqual([String(SRC_UNZONED_PLANT)]);
  });

  it('itemises a company no in-scope plant references as NO_INSCOPE_PLANT', async () => {
    const result = await makeService().sync();
    runIds.push(result.runId);

    expect(result.stats.companies.skippedByReason?.NO_INSCOPE_PLANT).toBe(1);

    const rejects = await prisma.masterSyncReject.findMany({
      where: { runId: result.runId, entity: 'companies', reason: 'NO_INSCOPE_PLANT' },
    });
    expect(rejects.map((r) => r.sourceKey)).toEqual([String(SRC_GHOST_CO)]);
  });

  it('splits vehicle skips: PLANT_NOT_SYNCED vs COMPANY_NOT_SYNCED, keyed by vehicle_no', async () => {
    const result = await makeService().sync();
    runIds.push(result.runId);

    expect(result.stats.vehicles.skippedByReason?.PLANT_NOT_SYNCED).toBe(1);
    expect(result.stats.vehicles.skippedByReason?.COMPANY_NOT_SYNCED).toBe(1);
    expect(result.stats.vehicles.skipped).toBe(2);

    const rejects = await prisma.masterSyncReject.findMany({
      where: { runId: result.runId, entity: 'vehicles' },
      orderBy: { rejectId: 'asc' },
    });
    expect(rejects.map((r) => ({ key: r.sourceKey, reason: r.reason }))).toEqual([
      { key: V_NOPLANT, reason: 'PLANT_NOT_SYNCED' },
      { key: V_NOCO, reason: 'COMPANY_NOT_SYNCED' },
    ]);
  });

  it('splits device skips: VEHICLE_NOT_SYNCED vs NO_FITTED_DEVICE, keyed by device id when present', async () => {
    const result = await makeService().sync();
    runIds.push(result.runId);

    expect(result.stats.devices.skippedByReason?.VEHICLE_NOT_SYNCED).toBe(2); // orphan device + deviceless unsynced vehicle
    expect(result.stats.devices.skippedByReason?.NO_FITTED_DEVICE).toBe(1);
    expect(result.stats.devices.skipped).toBe(3);

    const rejects = await prisma.masterSyncReject.findMany({
      where: { runId: result.runId, entity: 'devices' },
      orderBy: { rejectId: 'asc' },
    });
    expect(rejects.map((r) => ({ key: r.sourceKey, reason: r.reason }))).toEqual([
      { key: DEV_ORPHAN, reason: 'VEHICLE_NOT_SYNCED' }, // device id known → itemised by device
      { key: V_NOCO, reason: 'VEHICLE_NOT_SYNCED' }, // no device id → falls back to vehicle_no
      { key: V_NODEV, reason: 'NO_FITTED_DEVICE' },
    ]);
  });

  it('a reject-write failure never fails the sync — counters still land on the run row', async () => {
    const spy = vi
      .spyOn(prisma.masterSyncReject, 'createMany')
      .mockRejectedValueOnce(new Error('rejects table unavailable'));
    try {
      const result = await makeService().sync();
      runIds.push(result.runId);

      expect(result.status).toBe('SUCCESS'); // accounting is best-effort, never load-bearing
      const run = await prisma.masterSyncRun.findUniqueOrThrow({ where: { runId: result.runId } });
      const entityStats = run.entityStats as Record<string, { skippedByReason?: Record<string, number> }>;
      expect(entityStats.plants.skippedByReason?.OUT_OF_SCOPE_STATUS).toBe(1); // counters survive

      const rejects = await prisma.masterSyncReject.count({ where: { runId: result.runId } });
      expect(rejects).toBe(0); // the itemised rows are the only thing lost
    } finally {
      spy.mockRestore();
    }
  });
});
