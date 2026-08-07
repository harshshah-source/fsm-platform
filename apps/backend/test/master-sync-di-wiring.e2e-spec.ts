import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { DeviceDepartureService } from '../src/device-departure/device-departure.service';
import {
  MASTER_SYNC_SOURCE,
  MasterSyncService,
  type MasterSyncSource,
} from '../src/ingestion/autoplant/master-sync.service';
import { PlantEligibleFloatingSeService } from '../src/org/plant-eligible-floating-se.service';
import { PrismaService } from '../src/prisma/prisma.service';
import type {
  MstCompanyRow,
  MstPlantRow,
  MstTransporterRow,
  VehicleMasterMasterRow,
} from '../src/ingestion/autoplant/master-mapping';

/**
 * Issue 218b — the deployment-lifecycle pass must actually run on the path production uses.
 *
 * The defect this pins is not a logic error; the lifecycle code was correct and covered by
 * `device-departure-lifecycle.e2e-spec.ts` throughout. It was **never wired**: every existing test
 * constructs `MasterSyncService` by hand (as does the CLI runner, which is why manual runs worked),
 * so nothing ever asserted that Nest can resolve its collaborators. `master-sync.service.ts` imported
 * `DeviceDepartureService` with `import type`; the erased import plus a `T | null` parameter type left
 * `design:paramtypes` at `Object`, Nest could not resolve the parameter, and `@Optional()` turned that
 * into a silent `undefined` — after which the pass returned before doing anything, for 27 consecutive
 * syncs, with no error and a green suite.
 *
 * So this spec boots the **real `AppModule`** — the same graph the scheduler and
 * `POST /api/integration/sync` resolve through — and overrides nothing but the AutoPlant source,
 * which cannot be reached from CI. A hand-constructed service here would re-create the blind spot.
 */
describe('Issue 218b — MasterSyncService lifecycle wiring (real DI graph)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let sync: MasterSyncService;

  const NS = Date.now() % 100_000;
  const SRC_COMPANY = 218001;
  const SRC_PLANT = 218002;
  const SRC_TRANSPORTER = 218003;
  const V_ONE = `ZZ218W${NS}`;
  const D_ONE = `RR_D218W${NS}`;

  const companies: MstCompanyRow[] = [
    { company_id: SRC_COMPANY, company_name: `Wiring Cement ${NS}`, company_type: 'NA', status: 'ACTIVE' },
  ];
  const transporters: MstTransporterRow[] = [
    {
      transporter_id: SRC_TRANSPORTER,
      company_id: SRC_COMPANY,
      transporter_name: `Wiring Roadways ${NS}`,
      status: 'ACTIVE',
    },
  ];
  const plants: MstPlantRow[] = [
    {
      plant_id: SRC_PLANT,
      company_id: SRC_COMPANY,
      plant_name: `Wiring Plant ${NS}`,
      zone_id: 2039,
      zone_name: 'South India',
      region_id: null,
      region_name: null,
      plant_state: 'Andhra Pradesh',
      plant_district: 'Kadapa',
      master_plant_id: null,
      master_plant_code: null,
      status: 'ACTIVE',
    },
  ];

  const vehicle = (status: string): VehicleMasterMasterRow => ({
    vehicle_no: V_ONE,
    device_id: D_ONE,
    plant_id: SRC_PLANT,
    company_id: SRC_COMPANY,
    transporter_id: SRC_TRANSPORTER,
    device_type: 'V5',
    deployment_status: status,
  });

  /** Rewritten between syncs to simulate AutoPlant changing under a live FSM. */
  let vehicleMasters: VehicleMasterMasterRow[] = [vehicle('DEPLOYED')];

  const source: MasterSyncSource = {
    readCompanies: async () => companies,
    readTransporters: async () => transporters,
    readPlants: async () => plants,
    readVehicleMasters: async () => vehicleMasters,
  };

  const cleanup = async (): Promise<void> => {
    await prisma.deviceDeparture.deleteMany({ where: { deviceId: D_ONE } });
    await prisma.auditLog.deleteMany({ where: { entityType: 'DEVICE', entityId: D_ONE } });
    await prisma.deviceState.deleteMany({ where: { deviceId: D_ONE } });
    await prisma.device.deleteMany({ where: { deviceId: D_ONE } });
    await prisma.vehicle.deleteMany({ where: { vehicleNo: V_ONE } });
    await prisma.transporter.deleteMany({ where: { sourceTransporterId: BigInt(SRC_TRANSPORTER) } });
    await prisma.plant.deleteMany({ where: { sourcePlantId: BigInt(SRC_PLANT) } });
    await prisma.company.deleteMany({ where: { sourceCompanyId: BigInt(SRC_COMPANY) } });
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // The ONLY override: AutoPlant is unreachable from CI. Everything else — the departure service,
      // the zone resolver, the scope, the eligibility MV — resolves through the real graph.
      .overrideProvider(MASTER_SYNC_SOURCE)
      .useValue(source)
      .compile();
    prisma = moduleRef.get(PrismaService);
    sync = moduleRef.get(MasterSyncService);
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await moduleRef.close();
  });

  it('resolves DeviceDepartureService through Nest DI — the assertion whose absence hid the defect', () => {
    // Reading the private collaborator directly is the point: this is precisely the value that was
    // silently `undefined` in production while every hand-constructed test passed.
    const injected = (sync as unknown as { departures: DeviceDepartureService | null }).departures;
    expect(injected).not.toBeNull();
    expect(injected).toBeInstanceOf(DeviceDepartureService);
  });

  it('resolves PlantEligibleFloatingSeService too — the second casualty of the same two imports', () => {
    const injected = (sync as unknown as { floatingEligibility: PlantEligibleFloatingSeService | null })
      .floatingEligibility;
    expect(injected).not.toBeNull();
    expect(injected).toBeInstanceOf(PlantEligibleFloatingSeService);
  });

  it('opens a departure through the real graph when a mirrored vehicle leaves the operational fleet', async () => {
    vehicleMasters = [vehicle('DEPLOYED')];
    const created = await sync.sync();
    expect(created.status).toBe('SUCCESS');
    expect(await prisma.device.findUnique({ where: { deviceId: D_ONE } })).not.toBeNull();
    expect(await prisma.deviceDeparture.findFirst({ where: { deviceId: D_ONE, restoredAt: null } })).toBeNull();

    // The source flips the vehicle out of the operational fleet.
    vehicleMasters = [vehicle('UNDEPLOYED')];
    const departed = await sync.sync();

    expect(departed.status).toBe('SUCCESS');
    // The counter that read {inserted: 0, updated: 0} for 27 consecutive runs.
    expect(departed.stats.departures).toMatchObject({ inserted: 1 });
    expect(await prisma.deviceDeparture.findFirst({ where: { deviceId: D_ONE, restoredAt: null } })).not.toBeNull();
    expect((await prisma.vehicle.findUnique({ where: { vehicleNo: V_ONE } }))?.status).toBe('UNDEPLOYED');
  });

  it('restores it through the real graph when the vehicle returns to the operational fleet', async () => {
    vehicleMasters = [vehicle('DEPLOYED')];
    const restored = await sync.sync();

    expect(restored.status).toBe('SUCCESS');
    expect(restored.stats.departures).toMatchObject({ updated: 1 });
    expect(await prisma.deviceDeparture.findFirst({ where: { deviceId: D_ONE, restoredAt: null } })).toBeNull();
    // Reversible, never destructive: the closed row keeps its history.
    const closed = await prisma.deviceDeparture.findFirst({ where: { deviceId: D_ONE } });
    expect(closed?.restoredAt).not.toBeNull();
    expect(closed?.restoredStatus).toBe('DEPLOYED');
  });
});
