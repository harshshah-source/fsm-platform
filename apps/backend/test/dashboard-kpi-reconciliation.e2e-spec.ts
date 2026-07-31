import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * KPI transparency — the dashboard's reconciliation identities (2026-07-29).
 *
 * The defect these tests exist to prevent: `zone-overview`'s denominator counted ALL mirrored devices
 * while its numerator (and the "Active Fleet" KPI) counted only non-departed ones, so `inactive /
 * total` divided an operational numerator by an operational+warehouse denominator. Live pan-India that
 * was 3,476 / 23,238 shown against a 17,415 KPI — every zone's inactive rate understated, unevenly,
 * because warehouse stock is not evenly distributed (West 14.7% departed vs South 39.4%).
 *
 * Two layers of tests:
 *
 *  1. SEEDED — a fixture zone with a known departed/inactive/healthy mix, asserting each endpoint
 *     reports the operational population exactly.
 *  2. WHOLE-DATABASE — the identities that must hold across every row the dev/CI database happens to
 *     contain, at every aggregation level. These are the real guard: they would have failed on the
 *     pre-fix code with the production dataset loaded, and they cannot be satisfied by a fixture that
 *     merely avoids departed devices.
 */
const ZM_ZONE = 1; // zm.north@fsm.test is zone 1

interface FleetCounts {
  mirroredDevices: number;
  operationalDevices: number;
  warehouseDevices: number;
  inactiveOperational: number;
  healthyOperational: number;
  inactivePct: number | null;
  fleetHealthPct: number | null;
}
type ZoneRow = FleetCounts & { zoneId: string; byBucket: Record<string, number> };
type CompanyPlantRow = FleetCounts & { companyId: string; plantId: string; byBucket: Record<string, number> };
type FleetSummary = FleetCounts & { companies: number; plants: number; catalogDevices: number | null; lastMasterSyncAt: string | null; lastSnapshotAt: string | null };
type FleetComposition = FleetCounts & { catalogDevices: number | null; notMirrored: number | null; mirroredTotal: number; onDeactivatedPlants: number; zoneScoped: boolean };
type FleetDirectory = { companies: Array<FleetCounts & { companyId: string; lastSnapshotAt: string | null; lastActivityAt: string | null }>; plants: Array<FleetCounts & { plantId: string }> };

const sum = <T>(rows: T[], pick: (r: T) => number) => rows.reduce((a, r) => a + pick(r), 0);

describe('Dashboard KPI reconciliation — one operational population at every level', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ohToken: string;
  let zoneId: bigint;
  let plantId: bigint;
  let healthyOnlyPlantId: bigint;
  let companyId: bigint;

  // 2 inactive + 3 healthy + 4 departed (2 of which are ALSO stale enough to have been inactive had
  // they not departed) = 9 mirrored, 5 operational at the fixture plant.
  const inactiveIds = [9_071_001n, 9_071_002n].map(String);
  const healthyIds = [9_071_003n, 9_071_004n, 9_071_005n].map(String);
  const departedIds = [9_071_006n, 9_071_007n, 9_071_008n, 9_071_009n].map(String);
  // A second plant with NO inactive devices at all — it must still appear in both tables, or its
  // operational devices silently drop out of the column totals (the vanishing-row bug).
  const healthyOnlyIds = [9_071_010n, 9_071_011n].map(String);
  const allIds = [...inactiveIds, ...healthyIds, ...departedIds, ...healthyOnlyIds];

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  };

  const get = async <T>(path: string, token: string): Promise<T> => {
    const res = await request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`).expect(200);
    return res.body as T;
  };

  /**
   * `isDeparted` is set directly rather than via a `device_departures` row: the dashboard reads the
   * denormalised `device_states.is_departed` mirror on the hot path, which is exactly what
   * `DeviceStateService.recompute` derives from the side table. Departed rows carry `isInactive:false`
   * and a null bucket because recompute forces both (`is_inactive = NOT departed AND …`).
   */
  const seedState = (deviceId: string, at: bigint, opts: { bucket?: string | null; departed?: boolean }) =>
    prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: !opts.departed && opts.bucket != null,
        inactivityHours: opts.bucket != null ? 30 : 1,
        slaBucket: (opts.departed ? null : (opts.bucket ?? null)) as never,
        isDeparted: opts.departed ?? false,
        eligibleForUptime: !opts.departed,
        plantId: at,
        companyId,
        computedAt: new Date(),
      },
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    const zone = await prisma.zone.create({ data: { name: 'Z-recon-' + Date.now() } });
    zoneId = zone.zoneId;
    plantId = (await prisma.plant.create({ data: { name: 'P-recon-mixed', zoneId } })).plantId;
    healthyOnlyPlantId = (await prisma.plant.create({ data: { name: 'P-recon-healthy', zoneId } })).plantId;
    companyId = (
      await prisma.company.create({
        data: { name: 'C-recon-' + Date.now(), companyTier: 'GOLD', companyPriorityRank: 'Z9' },
      })
    ).companyId;

    for (const id of allIds) await prisma.device.create({ data: { deviceId: id } });
    await seedState(inactiveIds[0], plantId, { bucket: 'CRITICAL' });
    await seedState(inactiveIds[1], plantId, { bucket: 'SEVERE' });
    for (const id of healthyIds) await seedState(id, plantId, { bucket: null });
    for (const id of departedIds) await seedState(id, plantId, { departed: true });
    for (const id of healthyOnlyIds) await seedState(id, healthyOnlyPlantId, { bucket: null });

    ohToken = await login('ops.head@fsm.test');
  });

  afterAll(async () => {
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: allIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: allIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [plantId, healthyOnlyPlantId] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await app.close();
  });

  // ---- 1. Seeded fixture: the operational population, exactly -----------------------------------

  it('zone-overview counts the OPERATIONAL population, excluding warehouse devices', async () => {
    const rows = await get<ZoneRow[]>('/api/dashboard/zone-overview', ohToken);
    const row = rows.find((r) => r.zoneId === zoneId.toString());
    expect(row).toBeDefined();
    // 5 operational at the mixed plant + 2 at the healthy-only plant; the 4 departed are warehouse.
    expect(row!.operationalDevices).toBe(7);
    expect(row!.warehouseDevices).toBe(4);
    expect(row!.mirroredDevices).toBe(11);
    expect(row!.inactiveOperational).toBe(2);
    expect(row!.healthyOperational).toBe(5);
  });

  it('derives the rates against the operational denominator, not the mirrored one', async () => {
    const rows = await get<ZoneRow[]>('/api/dashboard/zone-overview', ohToken);
    const row = rows.find((r) => r.zoneId === zoneId.toString())!;
    // 2/7 = 28.6%, NOT 2/11 = 18.2% — the pre-fix denominator would have produced the latter.
    expect(row.inactivePct).toBeCloseTo(28.6, 1);
    expect(row.fleetHealthPct).toBeCloseTo(71.4, 1);
    expect(row.inactivePct! + row.fleetHealthPct!).toBeCloseTo(100, 1);
  });

  it('keeps an entity with zero inactive devices in both tables (it still owns operational devices)', async () => {
    const [zones, cps] = await Promise.all([
      get<ZoneRow[]>('/api/dashboard/zone-overview', ohToken),
      get<CompanyPlantRow[]>('/api/dashboard/company-plant-overview', ohToken),
    ]);
    const healthyPlant = cps.find((r) => r.plantId === healthyOnlyPlantId.toString());
    expect(healthyPlant).toBeDefined();
    expect(healthyPlant!.inactiveOperational).toBe(0);
    expect(healthyPlant!.operationalDevices).toBe(2);
    // …and its devices are inside the zone row's operational total.
    const zone = zones.find((r) => r.zoneId === zoneId.toString())!;
    expect(zone.operationalDevices).toBe(
      sum(cps.filter((r) => r.plantId === plantId.toString() || r.plantId === healthyOnlyPlantId.toString()), (r) => r.operationalDevices),
    );
  });

  it('company-plant-overview reports the same operational population as the zone row', async () => {
    const rows = await get<CompanyPlantRow[]>('/api/dashboard/company-plant-overview', ohToken);
    const row = rows.find((r) => r.plantId === plantId.toString())!;
    expect(row.operationalDevices).toBe(5);
    expect(row.warehouseDevices).toBe(4);
    expect(row.inactiveOperational).toBe(2);
    expect(row.healthyOperational).toBe(3);
  });

  // ---- 2. Whole-database identities: the guard that actually bites ------------------------------

  it('Σ zone == fleet-summary, for every operational count', async () => {
    const [zones, fleet] = await Promise.all([
      get<ZoneRow[]>('/api/dashboard/zone-overview', ohToken),
      get<FleetSummary>('/api/dashboard/fleet-summary', ohToken),
    ]);
    expect(sum(zones, (z) => z.operationalDevices)).toBe(fleet.operationalDevices);
    expect(sum(zones, (z) => z.inactiveOperational)).toBe(fleet.inactiveOperational);
    expect(sum(zones, (z) => z.warehouseDevices)).toBe(fleet.warehouseDevices);
    expect(sum(zones, (z) => z.healthyOperational)).toBe(fleet.healthyOperational);
    expect(sum(zones, (z) => z.mirroredDevices)).toBe(fleet.mirroredDevices);
  });

  it('Σ company×plant == Σ zone == fleet-summary (the Part 5 hierarchy)', async () => {
    const [zones, cps, fleet] = await Promise.all([
      get<ZoneRow[]>('/api/dashboard/zone-overview', ohToken),
      get<CompanyPlantRow[]>('/api/dashboard/company-plant-overview', ohToken),
      get<FleetSummary>('/api/dashboard/fleet-summary', ohToken),
    ]);
    expect(sum(cps, (r) => r.operationalDevices)).toBe(sum(zones, (z) => z.operationalDevices));
    expect(sum(cps, (r) => r.operationalDevices)).toBe(fleet.operationalDevices);
    expect(sum(cps, (r) => r.inactiveOperational)).toBe(fleet.inactiveOperational);
    expect(sum(cps, (r) => r.warehouseDevices)).toBe(fleet.warehouseDevices);
  });

  it('fleet-directory companies and plants both reconcile with the KPI strip', async () => {
    const [dir, fleet] = await Promise.all([
      get<FleetDirectory>('/api/dashboard/fleet-directory', ohToken),
      get<FleetSummary>('/api/dashboard/fleet-summary', ohToken),
    ]);
    for (const rows of [dir.companies, dir.plants]) {
      expect(sum(rows, (r) => r.operationalDevices)).toBe(fleet.operationalDevices);
      expect(sum(rows, (r) => r.warehouseDevices)).toBe(fleet.warehouseDevices);
      expect(sum(rows, (r) => r.inactiveOperational)).toBe(fleet.inactiveOperational);
      expect(sum(rows, (r) => r.healthyOperational)).toBe(fleet.healthyOperational);
    }
    expect(dir.companies.length).toBe(fleet.companies);
  });

  it('healthy + inactive == operational, and operational + warehouse == mirrored, at every level', async () => {
    const [zones, cps, fleet, dir] = await Promise.all([
      get<ZoneRow[]>('/api/dashboard/zone-overview', ohToken),
      get<CompanyPlantRow[]>('/api/dashboard/company-plant-overview', ohToken),
      get<FleetSummary>('/api/dashboard/fleet-summary', ohToken),
      get<FleetDirectory>('/api/dashboard/fleet-directory', ohToken),
    ]);
    const rows: FleetCounts[] = [fleet, ...zones, ...cps, ...dir.companies, ...dir.plants];
    for (const r of rows) {
      expect(r.healthyOperational + r.inactiveOperational).toBe(r.operationalDevices);
      expect(r.operationalDevices + r.warehouseDevices).toBe(r.mirroredDevices);
    }
  });

  it('Σ byBucket == inactiveOperational on every zone and company×plant row', async () => {
    const [zones, cps] = await Promise.all([
      get<ZoneRow[]>('/api/dashboard/zone-overview', ohToken),
      get<CompanyPlantRow[]>('/api/dashboard/company-plant-overview', ohToken),
    ]);
    for (const r of [...zones, ...cps]) {
      const bucketed = Object.values(r.byBucket).reduce((a, n) => a + n, 0);
      expect(bucketed).toBe(r.inactiveOperational);
    }
  });

  it('fleet-composition closes with no unexplained losses', async () => {
    const [comp, fleet] = await Promise.all([
      get<FleetComposition>('/api/dashboard/fleet-composition', ohToken),
      get<FleetSummary>('/api/dashboard/fleet-summary', ohToken),
    ]);
    expect(comp.zoneScoped).toBe(false);
    // Step by step, each drop accounted for.
    expect(comp.mirroredTotal - comp.onDeactivatedPlants).toBe(comp.mirroredDevices);
    expect(comp.mirroredDevices).toBe(comp.operationalDevices + comp.warehouseDevices);
    expect(comp.operationalDevices).toBe(comp.healthyOperational + comp.inactiveOperational);
    // …and the funnel's operational tail is the same population the KPI strip reports.
    expect(comp.operationalDevices).toBe(fleet.operationalDevices);
    expect(comp.warehouseDevices).toBe(fleet.warehouseDevices);
    if (comp.catalogDevices !== null) {
      expect(comp.notMirrored).toBe(comp.catalogDevices - comp.mirroredTotal);
    }
  });

  it('scopes a Zonal Manager and omits the pan-India catalog steps from their funnel', async () => {
    const zmToken = await login('zm.north@fsm.test');
    const [comp, zones] = await Promise.all([
      get<FleetComposition>('/api/dashboard/fleet-composition', zmToken),
      get<ZoneRow[]>('/api/dashboard/zone-overview', zmToken),
    ]);
    expect(comp.zoneScoped).toBe(true);
    // The catalog counter has no zone attribution, so a zone-scoped funnel must not claim one.
    expect(comp.catalogDevices).toBeNull();
    expect(comp.notMirrored).toBeNull();
    expect(zones.every((z) => z.zoneId === String(ZM_ZONE))).toBe(true);
    expect(comp.operationalDevices).toBe(sum(zones, (z) => z.operationalDevices));
  });

  it('surfaces the freshness stamps the KPI tooltips cite', async () => {
    const fleet = await get<FleetSummary>('/api/dashboard/fleet-summary', ohToken);
    // Nullable on a fresh DB, but never undefined — the UI distinguishes "—" from a missing field.
    expect(fleet).toHaveProperty('lastMasterSyncAt');
    expect(fleet).toHaveProperty('lastSnapshotAt');
    expect(fleet).toHaveProperty('catalogDevices');
  });

  it('forbids a Service Engineer from the composition endpoint', async () => {
    const seToken = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .get('/api/dashboard/fleet-composition')
      .set('Authorization', `Bearer ${seToken}`)
      .expect(403);
  });

  it('requires authentication for the composition endpoint', async () => {
    await request(app.getHttpServer()).get('/api/dashboard/fleet-composition').expect(401);
  });
});
