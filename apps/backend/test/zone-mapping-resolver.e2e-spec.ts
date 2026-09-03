import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit.service';
import { MappingTableZoneResolver } from '../src/ingestion/autoplant/mapping-table-zone-resolver';
import type { MstPlantRow } from '../src/ingestion/autoplant/master-mapping';
import { ZoneMappingService } from '../src/org/zone-mapping.service';
import type { RequestActor } from '../src/common/request-actor';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * R6 translation layer — the data-driven `MappingTableZoneResolver` + `ZoneMappingService`.
 * Proves the three-tier precedence (plant override → MAPPED value-map → PENDING/UNZONED), the
 * auto-discovery of unmapped values onto the admin work queue, and the FSM-owned `reapply` that makes
 * an admin edit take effect on already-synced plants (master-sync itself is insert-only on zone_id).
 */
describe('R6 — MappingTableZoneResolver + ZoneMappingService', () => {
  let prisma: PrismaService;
  let resolver: MappingTableZoneResolver;
  let service: ZoneMappingService;

  let unzonedId: bigint;
  let westId: bigint;
  let northId: bigint;

  const SRC_PLANT = 995001n;
  const SRC_PLANT_OVERRIDE = 995002n;
  // A synthetic zone-name family ("Testonia Zone"/"TESTONIA" → key 'testonia'), NOT a canonical one:
  // org-seed pre-maps the real compass keys (west/north/south/east) as MAPPED, so building the
  // discovery tests on 'west' would race any concurrent reseed. The normalization proof is identical.
  const KEY_FAMILY = 'testonia';
  const KEY_JUNK = 'sdf';

  const actor: RequestActor = { userId: '00000000-0000-0000-0000-000000000001', role: 'OPERATIONS_HEAD', actedAsRole: null, actingZone: null, zoneId: null };

  const plant = (over: Partial<MstPlantRow>): MstPlantRow => ({
    plant_id: 0,
    company_id: 1,
    plant_name: 'P',
    zone_id: null,
    zone_name: null,
    region_id: null,
    region_name: null,
    plant_state: null,
    plant_district: null,
    master_plant_id: null,
    master_plant_code: null,
    status: 'ACTIVE',
    ...over,
  });

  const cleanup = async (): Promise<void> => {
    await prisma.plantZoneOverride.deleteMany({ where: { sourcePlantId: { in: [SRC_PLANT, SRC_PLANT_OVERRIDE] } } });
    await prisma.zoneMapping.deleteMany({ where: { sourceValueKey: { in: [KEY_FAMILY, KEY_JUNK] } } });
    await prisma.plant.deleteMany({ where: { sourcePlantId: { in: [SRC_PLANT, SRC_PLANT_OVERRIDE] } } });
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new ZoneMappingService(prisma, new AuditService(prisma));
    resolver = new MappingTableZoneResolver(prisma);

    // The resolver depends on a seeded UNZONED holding zone (org-seed provides it in real runs).
    const unzoned = await prisma.zone.upsert({ where: { name: 'UNZONED' }, create: { name: 'UNZONED' }, update: {} });
    const west = await prisma.zone.upsert({ where: { name: 'West' }, create: { name: 'West' }, update: {} });
    const north = await prisma.zone.upsert({ where: { name: 'North' }, create: { name: 'North' }, update: {} });
    unzonedId = unzoned.zoneId;
    westId = west.zoneId;
    northId = north.zoneId;
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.onModuleDestroy();
  });

  it('lands an unmapped value in UNZONED and discovers it as a PENDING queue row (seen_count grows)', async () => {
    const row = plant({ plant_id: Number(SRC_PLANT), zone_name: 'Testonia Zone' });

    const first = await resolver.resolve(row);
    expect(first?.zoneId).toBe(unzonedId);

    let mapping = await prisma.zoneMapping.findUniqueOrThrow({
      where: { sourceField_sourceValueKey: { sourceField: 'zone_name', sourceValueKey: KEY_FAMILY } },
    });
    expect(mapping.status).toBe('PENDING');
    expect(mapping.seenCount).toBe(1);
    expect(mapping.sourceValueRaw).toBe('Testonia Zone');

    await resolver.resolve(row);
    mapping = await prisma.zoneMapping.findUniqueOrThrow({
      where: { sourceField_sourceValueKey: { sourceField: 'zone_name', sourceValueKey: KEY_FAMILY } },
    });
    expect(mapping.seenCount).toBe(2); // re-seen, not duplicated
  });

  it('routes a MAPPED value to its FSM zone (normalizing TESTONIA/Testonia Zone to the same key)', async () => {
    const mapping = await prisma.zoneMapping.findUniqueOrThrow({
      where: { sourceField_sourceValueKey: { sourceField: 'zone_name', sourceValueKey: KEY_FAMILY } },
    });
    await service.mapValue(mapping.id, westId, actor);

    // A different raw spelling ('TESTONIA') must hit the same normalized key and resolve to West.
    const resolved = await resolver.resolve(plant({ plant_id: Number(SRC_PLANT), zone_name: 'TESTONIA' }));
    expect(resolved?.zoneId).toBe(westId);
  });

  it('lets a plant-level override win over the value map', async () => {
    // Value 'Testonia Zone' → West, but this specific plant is pinned to North.
    await service.upsertOverride(SRC_PLANT, northId, 'conflict fix', actor);
    const resolved = await resolver.resolve(plant({ plant_id: Number(SRC_PLANT), zone_name: 'Testonia Zone' }));
    expect(resolved?.zoneId).toBe(northId);

    await service.deleteOverride(SRC_PLANT, actor);
    const afterDelete = await resolver.resolve(plant({ plant_id: Number(SRC_PLANT), zone_name: 'Testonia Zone' }));
    expect(afterDelete?.zoneId).toBe(westId); // falls back to the value map
  });

  it('reapply moves already-synced plants from UNZONED to their now-mapped zone (and honours overrides)', async () => {
    // Two synced plants sitting in UNZONED, both with mirrored sourceZoneName 'Testonia Zone'.
    await prisma.plant.create({
      data: { name: 'Synced A', zoneId: unzonedId, sourcePlantId: SRC_PLANT, sourceZoneName: 'Testonia Zone' },
    });
    await prisma.plant.create({
      data: { name: 'Synced B', zoneId: unzonedId, sourcePlantId: SRC_PLANT_OVERRIDE, sourceZoneName: 'Testonia Zone' },
    });
    // Plant B is overridden to North; the mapping ('testonia'→West) is already MAPPED from earlier.
    await service.upsertOverride(SRC_PLANT_OVERRIDE, northId, 'pin B north', actor);

    const result = await service.reapply(actor);
    expect(result.updated).toBeGreaterThanOrEqual(2);

    const a = await prisma.plant.findUniqueOrThrow({ where: { sourcePlantId: SRC_PLANT } });
    const b = await prisma.plant.findUniqueOrThrow({ where: { sourcePlantId: SRC_PLANT_OVERRIDE } });
    expect(a.zoneId).toBe(westId); // value map
    expect(b.zoneId).toBe(northId); // override wins

    // Idempotent: a second reapply changes nothing.
    const again = await service.reapply(actor);
    const consideredIds = [SRC_PLANT, SRC_PLANT_OVERRIDE];
    const changedOurs = await prisma.plant.findMany({
      where: { sourcePlantId: { in: consideredIds }, zoneId: unzonedId },
    });
    expect(changedOurs).toHaveLength(0);
    expect(again.updated).toBeGreaterThanOrEqual(0);
  });

  it('IGNORE takes a junk value off the queue but still lands the plant in UNZONED', async () => {
    const junkPlant = plant({ plant_id: Number(SRC_PLANT), zone_name: 'sdf' });
    await resolver.resolve(junkPlant);
    const mapping = await prisma.zoneMapping.findUniqueOrThrow({
      where: { sourceField_sourceValueKey: { sourceField: 'zone_name', sourceValueKey: KEY_JUNK } },
    });
    await service.ignoreValue(mapping.id, actor);

    const pending = await service.listPending();
    expect(pending.find((m) => m.sourceValueKey === KEY_JUNK)).toBeUndefined();

    const resolved = await resolver.resolve(junkPlant);
    expect(resolved?.zoneId).toBe(unzonedId); // IGNORED still lands UNZONED, not resurrected to PENDING
    const after = await prisma.zoneMapping.findUniqueOrThrow({
      where: { sourceField_sourceValueKey: { sourceField: 'zone_name', sourceValueKey: KEY_JUNK } },
    });
    expect(after.status).toBe('IGNORED');
  });
});
