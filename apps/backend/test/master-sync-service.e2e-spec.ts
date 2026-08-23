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
 * Phase 4 — MasterSyncService, PLANT-FIRST derivation (mst_plant is the authoritative master; its
 * company_id is NOT NULL). Proves against a fake `ap_masters` source:
 *   • scope is anchored on plants (status + the R6 zone resolver); companies are DERIVED — created only
 *     when an in-scope plant names them (no company allow-list, mst_company.company_type never consulted);
 *   • a Transporter-TYPED company that owns an in-scope plant IS created (it's an FSM customer), while an
 *     unreferenced / INACTIVE-only company is NOT;
 *   • the anti-drift property (Risk R4) — a re-sync mirrors AutoPlant attributes but never clobbers
 *     FSM-owned data (ops_override/tier/rank, zone_id, deal_type).
 */
describe('Phase 4 — MasterSyncService (plant-first)', () => {
  let prisma: PrismaService;
  let runService: MasterSyncRunService;
  let service: MasterSyncService;
  let zoneId: bigint;

  const SRC_COMPANY = 900001n; // owns an in-scope plant → created
  const SRC_TRANSPORTER_TYPED_CO = 900010n; // company_type='Transporter' but owns an in-scope plant → created
  const SRC_UNREF_CO = 900099n; // owns only an INACTIVE plant → NOT created
  const SRC_PLANT = 900002n;
  const SRC_STEEL_PLANT = 900011n;
  const SRC_INACTIVE_PLANT = 900003n;
  const SRC_TRANSPORTER = 900004n;
  const VNO = 'ZZP4TEST0001';
  const DEV = '0899000000000001';

  const scope: MasterSyncScope = { plantStatuses: ['ACTIVE'] };

  const companies: MstCompanyRow[] = [
    { company_id: Number(SRC_COMPANY), company_name: 'Test Cement', company_type: 'NA', status: 'ACTIVE' },
    // A Transporter-TYPED company that owns a real active plant — must still be created (company_type ignored).
    {
      company_id: Number(SRC_TRANSPORTER_TYPED_CO),
      company_name: 'GB Transport',
      company_type: 'Transporter',
      status: 'ACTIVE',
    },
    // Referenced only by an INACTIVE plant → inert → never created.
    { company_id: Number(SRC_UNREF_CO), company_name: 'Ghost Co', company_type: 'Shipper', status: 'ACTIVE' },
  ];
  const transporters: MstTransporterRow[] = [
    {
      transporter_id: Number(SRC_TRANSPORTER),
      company_id: Number(SRC_COMPANY),
      transporter_name: 'Test Roadways',
      status: 'ACTIVE',
    },
  ];
  const plant = (over: Partial<MstPlantRow>): MstPlantRow => ({
    plant_id: 0,
    company_id: Number(SRC_COMPANY),
    plant_name: 'Plant',
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
    plant({ plant_id: Number(SRC_PLANT), company_id: Number(SRC_COMPANY), plant_name: 'Test Plant' }),
    plant({
      plant_id: Number(SRC_STEEL_PLANT),
      company_id: Number(SRC_TRANSPORTER_TYPED_CO),
      plant_name: 'Bokaro Steel Plant',
    }),
    plant({
      plant_id: Number(SRC_INACTIVE_PLANT),
      company_id: Number(SRC_UNREF_CO),
      plant_name: 'Ghost Inactive Plant',
      status: 'INACTIVE',
    }),
  ];
  const vehicleMasters: VehicleMasterMasterRow[] = [
    {
      vehicle_no: VNO,
      device_id: DEV,
      plant_id: Number(SRC_PLANT),
      company_id: Number(SRC_COMPANY), // reader supplies this via the plant join
      transporter_id: Number(SRC_TRANSPORTER),
      device_type: 'V5',
      deployment_status: 'DEPLOYED',
    },
  ];

  const source: MasterSyncSource = {
    readCompanies: async () => companies,
    readTransporters: async () => transporters,
    readPlants: async () => plants,
    readVehicleMasters: async () => vehicleMasters,
  };

  // R6 seam: parks every plant into the seeded operational zone (real resolver = state→zone map, gated).
  const zoneResolver: PlantZoneResolver = { resolve: async () => ({ zoneId, districtId: null }) };

  const cleanup = async (): Promise<void> => {
    await prisma.device.deleteMany({ where: { deviceId: DEV } });
    await prisma.vehicle.deleteMany({ where: { vehicleNo: VNO } });
    await prisma.transporter.deleteMany({ where: { sourceTransporterId: SRC_TRANSPORTER } });
    await prisma.plant.deleteMany({
      where: { sourcePlantId: { in: [SRC_PLANT, SRC_STEEL_PLANT, SRC_INACTIVE_PLANT] } },
    });
    await prisma.company.deleteMany({
      where: { sourceCompanyId: { in: [SRC_COMPANY, SRC_TRANSPORTER_TYPED_CO, SRC_UNREF_CO] } },
    });
    await prisma.masterSyncRun.deleteMany({ where: { status: 'RUNNING' } });
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    runService = new MasterSyncRunService(prisma);
    service = new MasterSyncService(prisma, runService, source, zoneResolver, scope);
    const zone = await prisma.zone.create({ data: { name: `P4_TEST_ZONE_${Date.now()}` } });
    zoneId = zone.zoneId;
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  /**
   * #261 (folding #132) — the master sync is the long run in this system, and the whole reason the
   * reaper stopped keying on `started_at`: a sync that legitimately takes longer than the threshold was
   * being reaped, losing its result and freeing the in-flight guard for a second sync over the top of
   * it. That only holds if the sync actually reports progress, so this pins the beat happening
   * repeatedly *during* a sync rather than once when the run row was opened.
   */
  it('beats through the sync, not just at the start, so a long run is never reaped for being long', async () => {
    const beatsAt: bigint[] = [];
    const counting = new MasterSyncRunService(prisma);
    const realHeartbeat = counting.heartbeat.bind(counting);
    counting.heartbeat = async (runId: bigint, now?: Date): Promise<void> => {
      beatsAt.push(runId);
      await realHeartbeat(runId, now);
    };

    const result = await new MasterSyncService(prisma, counting, source, zoneResolver, scope).sync();

    expect(result.status).toBe('SUCCESS');
    // Six numbered stages follow the first; one beat each. The exact number is the stage count, not a
    // magic constant — if a stage is added or removed this figure moves with it, deliberately.
    expect(beatsAt).toHaveLength(6);
    expect(beatsAt.every((id) => id === result.runId)).toBe(true);
    const run = await prisma.masterSyncRun.findUniqueOrThrow({ where: { runId: result.runId } });
    expect(run.heartbeatAt).not.toBeNull();
  });

  it('scopes plants, derives companies from them, and ignores company_type', async () => {
    const result = await service.sync();
    expect(result.status).toBe('SUCCESS');

    // In-scope plants synced; the INACTIVE plant excluded.
    expect(await prisma.plant.findUnique({ where: { sourcePlantId: SRC_PLANT } })).not.toBeNull();
    expect(await prisma.plant.findUnique({ where: { sourcePlantId: SRC_STEEL_PLANT } })).not.toBeNull();
    expect(await prisma.plant.findUnique({ where: { sourcePlantId: SRC_INACTIVE_PLANT } })).toBeNull();

    // Companies are DERIVED from in-scope plants. The Transporter-typed owner of a real plant is created…
    const company = await prisma.company.findUnique({ where: { sourceCompanyId: SRC_COMPANY } });
    const transporterTyped = await prisma.company.findUnique({
      where: { sourceCompanyId: SRC_TRANSPORTER_TYPED_CO },
    });
    expect(company?.name).toBe('Test Cement');
    expect(transporterTyped?.name).toBe('GB Transport'); // company_type='Transporter' did NOT exclude it
    // …but a company whose only plant is INACTIVE is inert and never created.
    expect(await prisma.company.findUnique({ where: { sourceCompanyId: SRC_UNREF_CO } })).toBeNull();

    // FK graph resolves: vehicle under the in-scope plant, company via the plant, device fitment.
    const plantRow = await prisma.plant.findUniqueOrThrow({ where: { sourcePlantId: SRC_PLANT } });
    const vehicle = await prisma.vehicle.findUnique({ where: { vehicleNo: VNO } });
    expect(vehicle?.plantId).toBe(plantRow.plantId);
    expect(vehicle?.companyId).toBe(company!.companyId);
    expect(vehicle?.status).toBe('DEPLOYED');
    const device = await prisma.device.findUnique({ where: { deviceId: DEV } });
    expect(device?.currentVehicleId).toBe(vehicle!.vehicleId);

    // Raw source-catalog size: every distinct fitted device_id the read observed (the "Total Devices"
    // dashboard number). One vehicle row carries one device here.
    expect(result.stats.devices.observed).toBe(1);
  });

  it('re-sync is idempotent and preserves FSM-owned columns while refreshing mirrored ones', async () => {
    await service.sync();
    const company = await prisma.company.findUniqueOrThrow({ where: { sourceCompanyId: SRC_COMPANY } });

    // Ops-Head decisions land AFTER the first sync — these must survive the next one.
    await prisma.company.update({
      where: { companyId: company.companyId },
      data: { opsOverride: true, companyTier: 'PLATINUM', companyPriorityRank: 'A' },
    });
    await prisma.device.update({ where: { deviceId: DEV }, data: { dealType: 'RECURRING' } });

    // AutoPlant renames the company and plant (mirrored attributes SHOULD refresh).
    companies[0].company_name = 'Test Cement RENAMED';
    plants[0].plant_name = 'Test Plant RENAMED';

    await service.sync();

    const companyCount = await prisma.company.count({ where: { sourceCompanyId: SRC_COMPANY } });
    expect(companyCount).toBe(1); // no duplicate — upsert matched on source id

    const after = await prisma.company.findUniqueOrThrow({ where: { sourceCompanyId: SRC_COMPANY } });
    expect(after.name).toBe('Test Cement RENAMED'); // mirrored → updated
    expect(after.opsOverride).toBe(true); // FSM-owned → preserved
    expect(after.companyTier).toBe('PLATINUM');
    expect(after.companyPriorityRank).toBe('A');

    const device = await prisma.device.findUniqueOrThrow({ where: { deviceId: DEV } });
    expect(device.dealType).toBe('RECURRING'); // FSM-owned → preserved

    const plantRow = await prisma.plant.findUniqueOrThrow({ where: { sourcePlantId: SRC_PLANT } });
    expect(plantRow.name).toBe('Test Plant RENAMED'); // mirrored → updated
    expect(plantRow.zoneId).toBe(zoneId); // FSM operational zone → preserved

    companies[0].company_name = 'Test Cement';
    plants[0].plant_name = 'Test Plant';
  });

  it('defers every plant the zone resolver cannot map, so no company is derived either — R6', async () => {
    const unresolvable = new MasterSyncService(prisma, runService, source, { resolve: async () => null }, scope);
    const result = await unresolvable.sync();
    expect(result.status).toBe('SUCCESS');
    expect(result.stats.plants.inserted + result.stats.plants.updated).toBe(0);
    expect(result.stats.plants.skipped).toBeGreaterThanOrEqual(1);
    // With no plant in scope there is nothing to derive companies from.
    expect(result.stats.companies.inserted).toBe(0);
  });

  it('defaults to ACTIVE-only plant scope when none is configured', async () => {
    const defaulted = new MasterSyncService(prisma, runService, source, zoneResolver, null);
    const result = await defaulted.sync();
    expect(result.status).toBe('SUCCESS');
    // The INACTIVE plant is still excluded under the default scope.
    expect(await prisma.plant.findUnique({ where: { sourcePlantId: SRC_INACTIVE_PLANT } })).toBeNull();
  });
});
