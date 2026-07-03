/**
 * Book8 master-data seeder — writes the CSV-derived graph + the minimum synthetic reference data
 * into the dev/test database IDEMPOTENTLY, preserving every foreign-key relationship in the existing
 * Prisma schema. No constraint is disabled, no existing seed row is deleted.
 *
 * Determinism: master rows are keyed by natural keys (zone name, company name, plant name+zone,
 * vehicle_no, device_id). createMany uses skipDuplicates, and synthetic PGI rows (tagged
 * orderRef='BOOK8-PGI') are delete-then-recreate scoped to that tag — so re-running converges to the
 * same world without ever touching non-Book8 data.
 *
 * Ordering respects FKs: zones → companies → plants → vehicles → devices → PGI.
 */
import type { PrismaService } from '../../../src/prisma/prisma.service';
import { seedOrgReferenceData } from '../../../src/org/org-seed';
import { type Book8Dataset } from './book8-dataset';

export interface SeedSummary {
  orgReference: Awaited<ReturnType<typeof seedOrgReferenceData>>;
  zones: number;
  companies: number;
  plants: number;
  vehicles: number;
  devices: number;
  pgiRows: number;
  deviceIds: string[];
}

const chunk = <T>(arr: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

export async function seedBook8Master(
  prisma: PrismaService,
  ds: Book8Dataset,
): Promise<SeedSummary> {
  // 0) Canonical org reference (component_master 1–4, common kit, SLA rules, scoring weights,
  //    geography). Idempotent; creates standard reference rows, deletes nothing.
  const orgReference = await seedOrgReferenceData(prisma as never);
  await prisma.systemSetting.upsert({
    where: { key: 'inactivity_threshold_hours' },
    create: { key: 'inactivity_threshold_hours', value: 24, description: 'Inactive threshold (h).' },
    update: {},
  });

  // 1) Zones — upsert by unique name.
  const zoneId = new Map<string, bigint>();
  for (const z of ds.zones) {
    const row = await prisma.zone.upsert({
      where: { name: z.name },
      create: { name: z.name },
      update: {},
    });
    zoneId.set(z.name, row.zoneId);
  }

  // 2) Companies — name is not unique in the schema, so guard by name (deterministic tier/rank).
  const companyId = new Map<string, bigint>();
  for (const c of ds.companies) {
    const existing = await prisma.company.findFirst({ where: { name: c.name } });
    const row =
      existing ??
      (await prisma.company.create({
        data: { name: c.name, companyTier: c.tier, companyPriorityRank: c.rank },
      }));
    companyId.set(c.key, row.companyId);
  }

  // 3) Plants — plant name is not unique; guard by (name, zoneId).
  const plantId = new Map<string, bigint>();
  for (const p of ds.plants) {
    const zId = zoneId.get(p.zone)!;
    const existing = await prisma.plant.findFirst({ where: { name: p.name, zoneId: zId } });
    const row = existing ?? (await prisma.plant.create({ data: { name: p.name, zoneId: zId } }));
    plantId.set(p.code, row.plantId);
  }

  // 4) Vehicles — bulk insert (skipDuplicates on the vehicle_no unique). Chunked to respect the
  //    Postgres parameter ceiling.
  const vehicleData = ds.usable.map((r) => ({
    vehicleNo: r.vehicleNo,
    plantId: plantId.get(r.plantCode)!,
    companyId: companyId.get(r.companyKey)!,
    transporterId: r.transporterId,
  }));
  for (const c of chunk(vehicleData, 2000)) {
    await prisma.vehicle.createMany({ data: c, skipDuplicates: true });
  }
  // Resolve vehicle_no → vehicleId for the device FK.
  const vehicleId = new Map<string, bigint>();
  for (const c of chunk(ds.usable.map((r) => r.vehicleNo), 2000)) {
    const rows = await prisma.vehicle.findMany({
      where: { vehicleNo: { in: c } },
      select: { vehicleId: true, vehicleNo: true },
    });
    for (const v of rows) vehicleId.set(v.vehicleNo, v.vehicleId);
  }

  // 5) Devices — bulk insert keyed on the real AutoPlant device_id (skipDuplicates).
  const deviceData = ds.usable.map((r) => ({
    deviceId: r.deviceId,
    currentVehicleId: vehicleId.get(r.vehicleNo) ?? null,
    dealType: r.dealType,
    deviceType: r.deviceType,
  }));
  for (const c of chunk(deviceData, 2000)) {
    await prisma.device.createMany({ data: c, skipDuplicates: true });
  }

  // 6) PGI history — synthetic, the one input the CSV cannot supply. Tagged so re-runs are clean.
  await prisma.pgiHistory.deleteMany({ where: { orderRef: 'BOOK8-PGI' } });
  const pgiData = ds.usable
    .filter((r) => r.pgiEligible)
    .map((r) => ({ deviceId: r.deviceId, pgiDate: ds.syntheticPgiDate, orderRef: 'BOOK8-PGI' }));
  let pgiRows = 0;
  for (const c of chunk(pgiData, 2000)) {
    const res = await prisma.pgiHistory.createMany({ data: c, skipDuplicates: true });
    pgiRows += res.count;
  }

  return {
    orgReference,
    zones: ds.zones.length,
    companies: ds.companies.length,
    plants: ds.plants.length,
    vehicles: vehicleData.length,
    devices: deviceData.length,
    pgiRows,
    deviceIds: ds.usable.map((r) => r.deviceId),
  };
}
