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
 * #324 F13 — one dirty source row cannot fail a masters run.
 *
 * The masters path was all-or-nothing on identity fields. `BigInt(String(row.plant_id).trim())` and
 * the `.trim()` on each name column throw on a null or non-numeric value, and nothing caught them, so
 * a single malformed row aborted the **entire** sync — every plant, company, transporter, vehicle and
 * device, on every run, until somebody fixed the source by hand. The telemetry path has answered this
 * shape since #299 (`UNPARSEABLE_TIMESTAMP`: drop the row, count it, keep draining); the masters path
 * predates that accounting and never got it.
 *
 * "Authoritative PKs cannot be dirty" is an assumption, not a guard, and this platform has already
 * been bitten by the same one twice — MySQL's `0000-00-00` in a datetime column (#323) and `'NA'` in a
 * device-id column (#323 again), both in tables that were equally authoritative.
 *
 * **The trade, stated because it is real:** a skipped master row leaves its FSM mirror row stale
 * rather than failing loudly. That is the same trade #299 made on the telemetry side, and it is only
 * acceptable because the skip is *counted* — per-reason on `entity_stats` and enumerable from
 * `master_sync_rejects`, which is what #300's surfacing reads.
 */
const NS = Date.now();

describe('#324 F13 — a dirty master row is skipped and counted, not fatal', () => {
  let prisma: PrismaService;
  let runService: MasterSyncRunService;
  let zoneId: bigint;
  const runIds: bigint[] = [];

  const SRC_CO = 924001n;
  const SRC_PLANT = 924011n;
  const SRC_TRANSPORTER = 924021n;
  const V_OK = 'ZZ324OK0001';
  const V_DIRTY = 'ZZ324DIRTY02';
  const DEV_OK = '0899240000000001';

  const scope: MasterSyncScope = { plantStatuses: ['ACTIVE'] };

  /** The clean row set every case starts from; each case dirties exactly one row. */
  const cleanCompanies = (): MstCompanyRow[] => [
    { company_id: Number(SRC_CO), company_name: 'F13 Cement', company_type: 'NA', status: 'ACTIVE' },
  ];
  const cleanTransporters = (): MstTransporterRow[] => [
    {
      transporter_id: Number(SRC_TRANSPORTER),
      company_id: Number(SRC_CO),
      transporter_name: 'F13 Haulage',
      status: 'ACTIVE',
    },
  ];
  const plant = (over: Partial<MstPlantRow>): MstPlantRow => ({
    plant_id: Number(SRC_PLANT),
    company_id: Number(SRC_CO),
    plant_name: 'F13 Plant',
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

  const sourceOf = (over: Partial<Record<string, unknown[]>> = {}): MasterSyncSource => ({
    readCompanies: async () => (over.companies as MstCompanyRow[]) ?? cleanCompanies(),
    readTransporters: async () => (over.transporters as MstTransporterRow[]) ?? cleanTransporters(),
    readPlants: async () => (over.plants as MstPlantRow[]) ?? [plant({})],
    readVehicleMasters: async () => (over.vehicles as VehicleMasterMasterRow[]) ?? [vehicle({})],
  });

  const zoneResolver: PlantZoneResolver = { resolve: async () => ({ zoneId, districtId: null }) };

  const run = async (over: Partial<Record<string, unknown[]>> = {}) => {
    const result = await new MasterSyncService(prisma, runService, sourceOf(over), zoneResolver, scope).sync();
    runIds.push(result.runId);
    return result;
  };

  const cleanup = async (): Promise<void> => {
    // Delete by the FK relationship, not by a hardcoded key list: a red run leaves rows behind whose
    // natural keys came from the dirty fixture, and a teardown that misses them fails the NEXT case on
    // a foreign-key violation instead of on its own assertion.
    const ours = await prisma.plant.findMany({ where: { sourcePlantId: SRC_PLANT }, select: { plantId: true } });
    const plantIds = ours.map((p) => p.plantId);
    const vehicles = await prisma.vehicle.findMany({
      where: { OR: [{ plantId: { in: plantIds } }, { vehicleNo: { in: [V_OK, V_DIRTY] } }] },
      select: { vehicleId: true },
    });
    await prisma.device.deleteMany({ where: { currentVehicleId: { in: vehicles.map((v) => v.vehicleId) } } });
    await prisma.device.deleteMany({ where: { deviceId: DEV_OK } });
    await prisma.vehicle.deleteMany({ where: { vehicleId: { in: vehicles.map((v) => v.vehicleId) } } });
    await prisma.plant.deleteMany({ where: { sourcePlantId: SRC_PLANT } });
    await prisma.transporter.deleteMany({ where: { sourceTransporterId: SRC_TRANSPORTER } });
    await prisma.company.deleteMany({ where: { sourceCompanyId: SRC_CO } });
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
    zoneId = (await prisma.zone.create({ data: { name: `F13_ZONE_${NS}` } })).zoneId;
    await cleanup();
  });

  afterEach(cleanup);

  afterAll(async () => {
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('a plant with a non-numeric plant_id is skipped; its siblings still sync', async () => {
    const result = await run({ plants: [plant({ plant_id: 'NA' }), plant({})] });

    // Before the fix this threw out of `mapPlant` and finalized the whole run FAILED.
    expect(result.status).toBe('SUCCESS');
    expect(result.stats.plants.skippedByReason?.UNPARSEABLE_IDENTITY).toBe(1);
    expect(result.stats.plants.inserted).toBe(1);
    expect(await prisma.plant.count({ where: { sourcePlantId: SRC_PLANT } })).toBe(1);

    const rejects = await prisma.masterSyncReject.findMany({
      where: { runId: result.runId, entity: 'plants', reason: 'UNPARSEABLE_IDENTITY' },
    });
    expect(rejects.map((r) => r.sourceKey)).toEqual(['NA']);
  });

  it('a plant with a blank name is skipped — the name is identity too, not decoration', async () => {
    // `plant_name` is NOT NULL on the mirror and is what every operator surface renders. A row that
    // cannot answer "which plant is this?" is not a partially-usable row.
    const result = await run({ plants: [plant({ plant_id: 924012, plant_name: '   ' }), plant({})] });

    expect(result.status).toBe('SUCCESS');
    expect(result.stats.plants.skippedByReason?.UNPARSEABLE_IDENTITY).toBe(1);
    expect(await prisma.plant.count({ where: { sourcePlantId: SRC_PLANT } })).toBe(1);
  });

  it('a dirty company is skipped without taking the plant that references it', async () => {
    const result = await run({
      companies: [{ company_id: 'NULL', company_name: 'F13 Broken', company_type: null, status: 'ACTIVE' }, ...cleanCompanies()],
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.stats.companies.skippedByReason?.UNPARSEABLE_IDENTITY).toBe(1);
    expect(await prisma.company.count({ where: { sourceCompanyId: SRC_CO } })).toBe(1);
    expect(await prisma.plant.count({ where: { sourcePlantId: SRC_PLANT } })).toBe(1);
  });

  it('a dirty transporter is skipped; the run still completes', async () => {
    const result = await run({
      transporters: [
        { transporter_id: 'x-7', company_id: Number(SRC_CO), transporter_name: 'F13 Bad', status: 'ACTIVE' },
        ...cleanTransporters(),
      ],
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.stats.transporters.skippedByReason?.UNPARSEABLE_IDENTITY).toBe(1);
    expect(await prisma.transporter.count({ where: { sourceTransporterId: SRC_TRANSPORTER } })).toBe(1);
  });

  it('a vehicle with a blank vehicle_no is skipped; the good vehicle and its device still land', async () => {
    // `vehicle_no` IS the vehicle's key on the mirror (`where: { vehicleNo }`), so a blank one has no
    // row to be. The fitted device hanging off it goes with it, as an unsynced-vehicle skip already did.
    const result = await run({
      vehicles: [vehicle({ vehicle_no: '  ', device_id: null }), vehicle({})],
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.stats.vehicles.skippedByReason?.UNPARSEABLE_IDENTITY).toBe(1);
    expect(await prisma.vehicle.count({ where: { vehicleNo: V_OK } })).toBe(1);
    expect(await prisma.device.count({ where: { deviceId: DEV_OK } })).toBe(1);
  });

  it('a clean run is untouched by the guard — no phantom skips', async () => {
    const result = await run();

    expect(result.status).toBe('SUCCESS');
    expect(result.stats.plants.skippedByReason?.UNPARSEABLE_IDENTITY).toBeUndefined();
    expect(result.stats.companies.skippedByReason?.UNPARSEABLE_IDENTITY).toBeUndefined();
    expect(result.stats.transporters.skippedByReason?.UNPARSEABLE_IDENTITY).toBeUndefined();
    expect(result.stats.vehicles.skippedByReason?.UNPARSEABLE_IDENTITY).toBeUndefined();
  });
});
