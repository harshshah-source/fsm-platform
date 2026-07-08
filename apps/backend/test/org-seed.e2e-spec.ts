import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import type { MstPlantRow } from '../src/ingestion/autoplant/master-mapping';
import { MappingTableZoneResolver } from '../src/ingestion/autoplant/mapping-table-zone-resolver';
import { seedOrgReferenceData } from '../src/org/org-seed';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 02 Slice 10 — reference/org seed (AC#7). The seed must load the canonical fixture and be
 * idempotent: running it twice leaves exactly one of each keyed row, so CI / dev re-seeds are safe.
 */
describe('Issue 02 Slice 10 — org reference seed', () => {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('loads canonical reference data and is idempotent', async () => {
    await seedOrgReferenceData(prisma);
    await seedOrgReferenceData(prisma);

    const north = await prisma.zone.findUnique({ where: { name: 'North' } });
    expect(north).not.toBeNull();

    const acmeRows = await prisma.company.findMany({ where: { name: 'Acme Logistics' } });
    expect(acmeRows).toHaveLength(1);
    expect(acmeRows[0].companyTier).toBe('PLATINUM');

    const platinumSla = await prisma.slaRuleConfig.findMany({
      where: { scope: 'company_tier', key: 'PLATINUM' },
    });
    expect(platinumSla).toHaveLength(1);
    expect(platinumSla[0].submitWithinMinutes).toBe(30);

    const v1Weights = await prisma.priorityRuleConfig.findMany({
      where: { weightSetRef: 'v1' },
    });
    expect(v1Weights.length).toBeGreaterThanOrEqual(3);

    const kit = await prisma.commonKitDefinition.findMany({
      where: { componentId: { in: [1n, 2n, 3n, 4n] } },
    });
    expect(kit).toHaveLength(4);

    // Representative geography for the Floating-SE territory selector (Issue 09): idempotent, with
    // district→region rollup wired.
    const konkan = await prisma.region.findMany({ where: { name: 'Konkan' } });
    expect(konkan).toHaveLength(1);
    expect(konkan[0].state).toBe('Maharashtra');

    const mumbai = await prisma.district.findMany({ where: { name: 'Mumbai City', state: 'Maharashtra' } });
    expect(mumbai).toHaveLength(1);
    expect(mumbai[0].regionId).toBe(konkan[0].regionId);
  });

  // Production evidence (2026-07, ap_masters.mst_plant.zone_name): ~98.7% of plants carry one of the
  // four canonical zone families ("West Zone"/"West"/"WEST", "North", "South", "East"). The seed
  // pre-maps those normalized keys so a fresh install zones the master automatically; everything else
  // ("Central", NA/blank, junk) stays a business decision on the PENDING queue.
  it('seeds the canonical zone_name crosswalk as MAPPED', async () => {
    await seedOrgReferenceData(prisma);

    const expected: [key: string, zoneName: string][] = [
      ['west', 'West'],
      ['north', 'North'],
      ['south', 'South'],
      ['east', 'East'],
    ];
    for (const [key, zoneName] of expected) {
      const mapping = await prisma.zoneMapping.findUnique({
        where: { sourceField_sourceValueKey: { sourceField: 'zone_name', sourceValueKey: key } },
        include: { zone: { select: { name: true } } },
      });
      expect(mapping?.status).toBe('MAPPED');
      expect(mapping?.zone?.name).toBe(zoneName);
    }

    // 'Central' and blank/NA are pending business decisions — the seed must never pre-map them.
    for (const key of ['central', '__blank__']) {
      const row = await prisma.zoneMapping.findUnique({
        where: { sourceField_sourceValueKey: { sourceField: 'zone_name', sourceValueKey: key } },
      });
      expect(row?.status).not.toBe('MAPPED');
    }
  });

  it('reseeding never clobbers an Ops decision on a crosswalk row', async () => {
    await seedOrgReferenceData(prisma);
    const south = await prisma.zone.findUniqueOrThrow({ where: { name: 'South' } });
    const east = await prisma.zone.findUniqueOrThrow({ where: { name: 'East' } });
    const eastKey = {
      sourceField_sourceValueKey: { sourceField: 'zone_name', sourceValueKey: 'east' },
    };

    // Simulate an Ops remap: raw "East" values now belong to the South zone.
    await prisma.zoneMapping.update({ where: eastKey, data: { fsmZoneId: south.zoneId } });
    await seedOrgReferenceData(prisma);
    const after = await prisma.zoneMapping.findUniqueOrThrow({ where: eastKey });
    expect(after.fsmZoneId).toBe(south.zoneId);

    // Restore the canonical mapping so other specs see the seeded baseline.
    await prisma.zoneMapping.update({ where: eastKey, data: { fsmZoneId: east.zoneId } });
  });

  // The West/WEST incident: org-seed used Title Case while fixtures used UPPERCASE, and the
  // case-SENSITIVE unique on zones.name let both in — splitting one operational zone into two and
  // making every case-insensitive zone lookup nondeterministic. Names differing only by case are the
  // same zone; the DB must refuse the second spelling outright.
  it('rejects a zone whose name differs from an existing zone only by case', async () => {
    const name = `CiProbe-${Date.now()}`;
    const created = await prisma.zone.create({ data: { name } });
    try {
      await expect(prisma.zone.create({ data: { name: name.toUpperCase() } })).rejects.toThrow();
    } finally {
      await prisma.zone.delete({ where: { zoneId: created.zoneId } });
    }
  });

  it('resolves the dominant production spelling "West Zone" straight to West after a bare seed', async () => {
    await seedOrgReferenceData(prisma);
    const svc = new PrismaService();
    await svc.onModuleInit();
    try {
      const resolver = new MappingTableZoneResolver(svc);
      const west = await prisma.zone.findUniqueOrThrow({ where: { name: 'West' } });
      const row: MstPlantRow = {
        plant_id: 0,
        company_id: 1,
        plant_name: 'P',
        zone_id: null,
        zone_name: 'West Zone',
        region_id: null,
        region_name: null,
        plant_state: null,
        plant_district: null,
        master_plant_id: null,
        master_plant_code: null,
        status: 'ACTIVE',
      };
      const resolved = await resolver.resolve(row);
      expect(resolved?.zoneId).toBe(west.zoneId);
    } finally {
      await svc.onModuleDestroy();
    }
  });
});
