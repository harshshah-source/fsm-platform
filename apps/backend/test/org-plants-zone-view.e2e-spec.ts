import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit.service';
import { PlantsService } from '../src/org/plants.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * #158 S2 — the read model behind the plant zone-reassignment surface.
 *
 * The override table keys on `source_plant_id` (the AutoPlant id), but `/api/org/plants` surfaced
 * only `{plantId, name, zoneId}` — so the admin console had no way to name the plant it was about to
 * pin, and no way to show what AutoPlant actually claims the zone is (the value the crosswalk failed
 * to resolve, which is the whole reason a plant needs pinning).
 */
describe('#158 — /org/plants zone-reassignment read model', () => {
  let prisma: PrismaService;
  let plants: PlantsService;

  const NS = 995201n;
  let zoneId: bigint;

  const cleanup = async (): Promise<void> => {
    await prisma.plant.deleteMany({ where: { sourcePlantId: NS } });
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    plants = new PlantsService(prisma, new AuditService(prisma));

    const zone = await prisma.zone.upsert({ where: { name: 'North' }, create: { name: 'North' }, update: {} });
    zoneId = zone.zoneId;
    await cleanup();
    await prisma.plant.create({
      data: { name: 'Zone View Plant', zoneId, sourcePlantId: NS, sourceZoneName: 'Testonia Zone' },
    });
  });

  afterAll(async () => {
    await cleanup();
    await prisma.onModuleDestroy();
  });

  it('exposes sourcePlantId, the resolved zone name, and the AutoPlant-claimed zone name', async () => {
    const rows = await plants.list();
    const row = rows.find((r) => r.sourcePlantId === NS.toString());

    expect(row).toBeDefined();
    expect(row).toMatchObject({
      name: 'Zone View Plant',
      zoneId: Number(zoneId),
      zoneName: 'North',
      sourceZoneName: 'Testonia Zone',
    });
  });

  it('leaves sourcePlantId null for an FSM-created plant that never came from AutoPlant', async () => {
    const created = await prisma.plant.create({ data: { name: 'Hand Made ' + NS, zoneId } });
    try {
      const rows = await plants.list();
      const row = rows.find((r) => r.plantId === Number(created.plantId));
      expect(row?.sourcePlantId).toBeNull();
      expect(row?.sourceZoneName).toBeNull();
    } finally {
      await prisma.plant.delete({ where: { plantId: created.plantId } });
    }
  });
});
