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
 * Phase 4 — MasterSyncService orchestration. Proves the decision-free core end-to-end against a fake
 * `ap_masters` source: FK-ordered upsert (companies → transporters → plants → vehicles → devices) keyed
 * by `source_*_id`, the R14 scope filter dropping an out-of-scope company, and — the load-bearing
 * property (Risk R4) — a re-sync mirroring AutoPlant attributes while NEVER clobbering FSM-owned data
 * (`ops_override`/tier/rank, `zone_id`, `deal_type`).
 *
 * The two business-gated decisions stay OUT of this test's truth: the operational `zoneId` comes from
 * an injected fake `PlantZoneResolver` (R6), and the scope VALUES are supplied as config (R14). Only
 * the mechanism is exercised here.
 */
describe('Phase 4 — MasterSyncService', () => {
  let prisma: PrismaService;
  let runService: MasterSyncRunService;
  let service: MasterSyncService;
  let zoneId: bigint;

  const SRC_COMPANY = 900001n;
  const SRC_OUT_OF_SCOPE = 900099n;
  const SRC_TRANSPORTER = 900003n;
  const SRC_PLANT = 900002n;
  const VNO = 'ZZP4TEST0001';
  const DEV = '0899000000000001';

  const scope: MasterSyncScope = { companyTypes: ['Shipper'], statuses: ['ACTIVE'] };

  // Mutable so a test can rename source attributes between syncs (to prove mirrored columns refresh).
  const companies: MstCompanyRow[] = [
    { company_id: Number(SRC_COMPANY), company_name: 'Test Cement', company_type: 'Shipper', status: 'ACTIVE' },
    {
      company_id: Number(SRC_OUT_OF_SCOPE),
      company_name: 'Out Of Scope Roadways',
      company_type: 'Transporter',
      status: 'ACTIVE',
    },
  ];
  const transporters: MstTransporterRow[] = [
    {
      transporter_id: Number(SRC_TRANSPORTER),
      company_id: Number(SRC_COMPANY),
      transporter_name: 'Test Roadways',
      status: 'ACTIVE',
    },
  ];
  const plants: MstPlantRow[] = [
    {
      plant_id: Number(SRC_PLANT),
      company_id: Number(SRC_COMPANY),
      plant_name: 'Test Plant',
      zone_id: 2039,
      zone_name: 'South India',
      region_id: null,
      region_name: null,
      plant_state: 'Andhra Pradesh',
      plant_district: 'Kadapa',
      master_plant_id: Number(SRC_PLANT),
      master_plant_code: 'T001',
      status: 'ACTIVE',
    },
  ];
  const vehicleMasters: VehicleMasterMasterRow[] = [
    {
      vehicle_no: VNO,
      device_id: DEV,
      plant_id: Number(SRC_PLANT),
      company_id: Number(SRC_COMPANY),
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

  // R6 seam: in the real world this is the state→zone map + UNZONED fallback (business-gated). Here it
  // just parks every plant into the seeded operational zone.
  const zoneResolver: PlantZoneResolver = {
    resolve: async () => ({ zoneId, districtId: null }),
  };

  const cleanup = async (): Promise<void> => {
    await prisma.device.deleteMany({ where: { deviceId: DEV } });
    await prisma.vehicle.deleteMany({ where: { vehicleNo: VNO } });
    await prisma.transporter.deleteMany({ where: { sourceTransporterId: SRC_TRANSPORTER } });
    await prisma.plant.deleteMany({ where: { sourcePlantId: SRC_PLANT } });
    await prisma.company.deleteMany({
      where: { sourceCompanyId: { in: [SRC_COMPANY, SRC_OUT_OF_SCOPE] } },
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

  it('syncs the in-scope org graph in FK order and drops the out-of-scope company', async () => {
    const result = await service.sync();
    expect(result.status).toBe('SUCCESS');

    const company = await prisma.company.findUnique({ where: { sourceCompanyId: SRC_COMPANY } });
    expect(company?.name).toBe('Test Cement');
    // R14: the Transporter-typed company is outside the supplied scope and must not be mirrored.
    const outOfScope = await prisma.company.findUnique({ where: { sourceCompanyId: SRC_OUT_OF_SCOPE } });
    expect(outOfScope).toBeNull();

    const transporter = await prisma.transporter.findUnique({
      where: { sourceTransporterId: SRC_TRANSPORTER },
    });
    expect(transporter?.companyId).toBe(company!.companyId);

    const plant = await prisma.plant.findUnique({ where: { sourcePlantId: SRC_PLANT } });
    expect(plant?.zoneId).toBe(zoneId);
    expect(plant?.plantState).toBe('Andhra Pradesh');

    const vehicle = await prisma.vehicle.findUnique({ where: { vehicleNo: VNO } });
    expect(vehicle?.plantId).toBe(plant!.plantId);
    expect(vehicle?.companyId).toBe(company!.companyId);
    expect(vehicle?.transporterId).toBe(transporter!.transporterId); // the new FK resolves
    expect(vehicle?.status).toBe('DEPLOYED');

    const device = await prisma.device.findUnique({ where: { deviceId: DEV } });
    expect(device?.currentVehicleId).toBe(vehicle!.vehicleId);
    expect(device?.deviceType).toBe('V5');
  });

  it('re-sync is idempotent and preserves FSM-owned columns while refreshing mirrored ones', async () => {
    // First sync establishes the graph.
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

    // No duplicate rows — the upsert matched on source ids.
    const companyCount = await prisma.company.count({ where: { sourceCompanyId: SRC_COMPANY } });
    expect(companyCount).toBe(1);

    const after = await prisma.company.findUniqueOrThrow({ where: { sourceCompanyId: SRC_COMPANY } });
    expect(after.name).toBe('Test Cement RENAMED'); // mirrored → updated
    expect(after.opsOverride).toBe(true); // FSM-owned → preserved
    expect(after.companyTier).toBe('PLATINUM');
    expect(after.companyPriorityRank).toBe('A');

    const device = await prisma.device.findUniqueOrThrow({ where: { deviceId: DEV } });
    expect(device.dealType).toBe('RECURRING'); // FSM-owned → preserved

    const plant = await prisma.plant.findUniqueOrThrow({ where: { sourcePlantId: SRC_PLANT } });
    expect(plant.name).toBe('Test Plant RENAMED'); // mirrored → updated
    expect(plant.zoneId).toBe(zoneId); // FSM operational zone → preserved

    // restore the fixture for isolation
    companies[0].company_name = 'Test Cement';
    plants[0].plant_name = 'Test Plant';
  });

  it('skips a plant the zone resolver cannot map (no invented UNZONED holding zone) — R6', async () => {
    const unresolvable = new MasterSyncService(prisma, runService, source, { resolve: async () => null }, scope);
    const result = await unresolvable.sync();
    expect(result.status).toBe('SUCCESS');
    expect(result.stats.plants.skipped).toBeGreaterThanOrEqual(1);
    expect(result.stats.plants.inserted + result.stats.plants.updated).toBe(0);
  });

  it('refuses to run when no scope is configured (R14 business gate, not a silent pass-through)', async () => {
    const unscoped = new MasterSyncService(prisma, runService, source, zoneResolver, null);
    await expect(unscoped.sync()).rejects.toThrow(/scope/i);
    await prisma.masterSyncRun.deleteMany({ where: { status: 'RUNNING' } });
  });
});
