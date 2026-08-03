/**
 * Book8 SE-organization seeder — deterministic, idempotent generation of the people + coverage the
 * Recommender / Day-Plan / availability workflows need. None of this is in the CSV, so it is
 * synthesized by stable business rules (keyed on plant code / SE email), preserving every FK.
 *
 *   • One Zonal Manager per zone, plus one Operations Head, one Central Service Manager, one
 *     Warehouse Manager (global).
 *   • 3–5 Service Engineers per plant: index 0 DEDICATED to the plant (capacity 15), the rest
 *     MULTI_PLANT (capacity 20) covering the plant + its next 1–2 same-zone neighbours.
 *   • Every SE gets an SeAvailability window (AVAILABLE), except every 20th SE which is ON_LEAVE so
 *     the Recommender's availability Hard Filter is exercised.
 *   • One SE Planner entry per zone (plant-visit bias signal).
 *
 * Idempotency: users keyed by email, engineer_master by id, coverage via the (seId,plantId) unique,
 * availability/planner guarded by existence — re-running converges without duplicates.
 */
import type { PrismaService } from '../../../src/prisma/prisma.service';
import { ensureCredential } from '../../../src/auth/credential-seed';
import { PlantEligibleFloatingSeService } from '../../../src/org/plant-eligible-floating-se.service';
import { ZONE_NAMES, type Book8Dataset } from './book8-dataset';

export interface SeOrgSummary {
  zonalManagers: number;
  operationsHead: number;
  centralServiceManager: number;
  warehouseManager: number;
  engineers: number;
  dedicated: number;
  multiPlant: number;
  coverageRows: number;
  onLeave: number;
  plannerEntries: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Same well-known test password every other spec logs in with — Book users are DB users like any
// other (#91: "no Book-specific code path"), so they get credentials the same generic way.
const BOOK_USER_PASSWORD = 'correct-password';

async function ensureUser(
  prisma: PrismaService,
  email: string,
  data: { name: string; role: string; phone: string; zoneId: bigint | null },
): Promise<string> {
  const existing = await prisma.user.findFirst({ where: { email } });
  const userId =
    existing?.userId ??
    (
      await prisma.user.create({
        data: {
          name: data.name,
          role: data.role as never,
          phone: data.phone,
          email,
          zoneId: data.zoneId ?? undefined,
        },
      })
    ).userId;

  // #91 S2 — every Book-seeded user gets a credential the same way an org-created user would, so
  // login has no Book-specific path. Idempotent: a re-run never rotates an existing hash.
  await ensureCredential(prisma, userId, BOOK_USER_PASSWORD);

  return userId;
}

export async function seedSeOrg(prisma: PrismaService, ds: Book8Dataset): Promise<SeOrgSummary> {
  // Availability windows + planner date track the SELECTED dataset's clock (not a hardcoded Book8
  // date) so AVAILABLE/ON_LEAVE windows are active relative to `ds.datasetNow` for every book.
  const availStart = new Date(ds.datasetNow.getTime() - DAY_MS);
  const plannedDate = new Date(
    Date.UTC(ds.datasetNow.getUTCFullYear(), ds.datasetNow.getUTCMonth(), ds.datasetNow.getUTCDate()),
  );
  // Resolve zone ids by name and plant ids by their derived (unique) names.
  const zoneRows = await prisma.zone.findMany({ where: { name: { in: [...ZONE_NAMES] } } });
  const zoneIdByName = new Map(zoneRows.map((z) => [z.name, z.zoneId]));

  const plantRows = await prisma.plant.findMany({
    where: { name: { in: ds.plants.map((p) => p.name) } },
    select: { plantId: true, name: true },
  });
  const plantIdByName = new Map(plantRows.map((p) => [p.name, p.plantId]));
  const plantIdByCode = new Map<string, bigint>();
  const zoneNameByCode = new Map<string, string>();
  for (const p of ds.plants) {
    const id = plantIdByName.get(p.name);
    if (id !== undefined) plantIdByCode.set(p.code, id);
    zoneNameByCode.set(p.code, p.zone);
  }

  // Plant codes grouped per zone, numerically sorted (for deterministic MULTI_PLANT neighbours).
  const codesByZone = new Map<string, string[]>();
  for (const p of [...ds.plants].sort((a, b) => Number(a.code) - Number(b.code))) {
    const list = codesByZone.get(p.zone) ?? [];
    list.push(p.code);
    codesByZone.set(p.zone, list);
  }

  const summary: SeOrgSummary = {
    zonalManagers: 0,
    operationsHead: 0,
    centralServiceManager: 0,
    warehouseManager: 0,
    engineers: 0,
    dedicated: 0,
    multiPlant: 0,
    coverageRows: 0,
    onLeave: 0,
    plannerEntries: 0,
  };

  // ── Managers ─────────────────────────────────────────────────────────────────────────────────
  for (const zoneName of ZONE_NAMES) {
    const zoneId = zoneIdByName.get(zoneName)!;
    const zmId = await ensureUser(prisma, `zm-${zoneName.toLowerCase()}@book8.test`, {
      name: `ZM ${zoneName}`,
      role: 'ZONAL_MANAGER',
      phone: `b8-zm-${zoneName}`,
      zoneId,
    });
    await prisma.zone.update({ where: { zoneId }, data: { zonalManagerUserId: zmId } });
    summary.zonalManagers++;
  }
  await ensureUser(prisma, 'ops-head@book8.test', {
    name: 'Operations Head',
    role: 'OPERATIONS_HEAD',
    phone: 'b8-oh',
    zoneId: null,
  });
  summary.operationsHead = 1;
  await ensureUser(prisma, 'csm@book8.test', {
    name: 'Central Service Manager',
    role: 'CENTRAL_SERVICE_MANAGER',
    phone: 'b8-csm',
    zoneId: null,
  });
  summary.centralServiceManager = 1;
  await ensureUser(prisma, 'wm@book8.test', {
    name: 'Warehouse Manager',
    role: 'WAREHOUSE_MANAGER',
    phone: 'b8-wm',
    zoneId: null,
  });
  summary.warehouseManager = 1;

  // ── Service Engineers per plant ────────────────────────────────────────────────────────────────
  let seIndex = 0;
  const plannerSeededZones = new Set<string>();
  for (const p of [...ds.plants].sort((a, b) => Number(a.code) - Number(b.code))) {
    const plantId = plantIdByCode.get(p.code);
    if (plantId === undefined) continue;
    const zoneId = zoneIdByName.get(p.zone)!;
    const zoneCodes = codesByZone.get(p.zone) ?? [p.code];
    const here = zoneCodes.indexOf(p.code);
    const seCount = 3 + (Math.abs(Number(p.code)) % 3); // 3–5, deterministic.

    for (let i = 0; i < seCount; i++) {
      const email = `se-${p.code}-${i}@book8.test`;
      const coverageType = i === 0 ? 'DEDICATED' : 'MULTI_PLANT';
      const seId = await ensureUser(prisma, email, {
        name: `SE ${p.code}-${i}`,
        role: 'SERVICE_ENGINEER',
        phone: `b8-se-${p.code}-${i}`,
        zoneId,
      });
      await prisma.engineerMaster.upsert({
        where: { engineerId: seId },
        create: {
          engineerId: seId,
          coverageType: coverageType as never,
          zoneId,
          dailyCapacity: i === 0 ? 15 : 20,
        },
        update: {},
      });

      // Coverage: DEDICATED → this plant; MULTI_PLANT → this plant + next 1–2 same-zone neighbours.
      const codes =
        coverageType === 'DEDICATED'
          ? [p.code]
          : [p.code, zoneCodes[here + 1], zoneCodes[here + 2]].filter((c): c is string => !!c);
      const covData = codes
        .map((code) => plantIdByCode.get(code))
        .filter((id): id is bigint => id !== undefined)
        .map((pid) => ({ seId, plantId: pid, coverageType: coverageType as never }));
      const cov = await prisma.seCoverage.createMany({ data: covData, skipDuplicates: true });
      summary.coverageRows += cov.count;

      // Availability: AVAILABLE, except every 20th SE → ON_LEAVE (exercises the availability filter).
      const onLeave = seIndex % 20 === 0;
      const hasAvail = await prisma.seAvailability.findFirst({ where: { seId } });
      if (!hasAvail) {
        await prisma.seAvailability.create({
          data: {
            seId,
            status: (onLeave ? 'ON_LEAVE' : 'AVAILABLE') as never,
            windowStart: availStart,
            windowEnd: null,
            reason: onLeave ? 'BOOK8 synthetic leave' : null,
          },
        });
      }
      if (onLeave) summary.onLeave++;

      summary.engineers++;
      if (coverageType === 'DEDICATED') summary.dedicated++;
      else summary.multiPlant++;

      // One planner entry per zone: the first DEDICATED SE visiting their plant on the dataset date.
      if (i === 0 && !plannerSeededZones.has(p.zone)) {
        await prisma.sePlanner.upsert({
          where: { seId_plantId_plannedDate: { seId, plantId, plannedDate } },
          create: { seId, plantId, plannedDate, createdBy: null },
          update: {},
        });
        plannerSeededZones.add(p.zone);
        summary.plannerEntries++;
      }
      seIndex++;
    }
  }

  // Populate the `plant_eligible_floating_se` MV so the Recommender's floating-SE lookup (Issue 10)
  // queries a populated relation instead of a freshly-migrated `WITH NO DATA` view (Postgres errors
  // 55000 on an unpopulated MV). No FLOATING territory is seeded here, so the MV is populated-but-empty
  // and the Recommender falls back to se_coverage — verified safe. `refresh()` handles the first-run
  // (non-concurrent) case internally; this only flips MV state, never business logic.
  await new PlantEligibleFloatingSeService(prisma).refresh();

  return summary;
}
