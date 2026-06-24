import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { SePlannerService } from '../src/planner/se-planner.service';

/**
 * Issue 14a, slice 2 — SE Planner CRUD (AC#2/#5). ZM-scoped create/list/delete of plant-visit
 * intents: upsert is idempotent on (se, plant, date); list is scoped to the ZM's zone; a ZM cannot
 * touch a plant outside their zone.
 */
const NS = Date.now();

describe('Issue 14a slice 2 — SePlannerService CRUD', () => {
  let prisma: PrismaService;
  let planner: SePlannerService;

  let zoneId: bigint;
  let otherZoneId: bigint;
  let plantId: bigint;
  let otherPlant: bigint;
  let se: string;
  const userIds: string[] = [];
  const ZM = { userId: '11111111-1111-1111-1111-111111111111', role: 'ZONAL_MANAGER', actedAsRole: null };
  let scope: { role: string; zoneId: number };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    planner = new SePlannerService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-pl-' + NS } })).zoneId;
    otherZoneId = (await prisma.zone.create({ data: { name: 'Z-pl-oth-' + NS } })).zoneId;
    scope = { role: 'ZONAL_MANAGER', zoneId: Number(zoneId) };
    plantId = (await prisma.plant.create({ data: { name: 'P-pl-' + NS, zoneId } })).plantId;
    otherPlant = (await prisma.plant.create({ data: { name: 'P-pl-oth-' + NS, zoneId: otherZoneId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@pl.test`, zoneId },
    });
    userIds.push(u.userId);
    se = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
  });

  afterAll(async () => {
    await prisma.sePlanner.deleteMany({ where: { seId: se } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [plantId, otherPlant] } } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: [zoneId, otherZoneId] } } });
    await prisma.onModuleDestroy();
  });

  it('upserts a planner entry idempotently and lists it within the ZM zone', async () => {
    const a = await planner.upsert({ seId: se, plantId: String(plantId), plannedDate: '2026-06-22' }, scope, ZM);
    expect(a.result).toBe('OK');
    const b = await planner.upsert({ seId: se, plantId: String(plantId), plannedDate: '2026-06-22' }, scope, ZM);
    expect(b.result).toBe('OK');

    const list = await planner.list({ dateFrom: '2026-06-22', dateTo: '2026-06-22' }, scope);
    const mine = list.filter((e) => e.seId === se);
    expect(mine).toHaveLength(1); // idempotent — one row for the triple
    expect(mine[0].plantId).toBe(String(plantId));
    expect(mine[0].plannedDate).toBe('2026-06-22');
  });

  it('rejects a ZM planning a plant outside their zone', async () => {
    const out = await planner.upsert({ seId: se, plantId: String(otherPlant), plannedDate: '2026-06-22' }, scope, ZM);
    expect(out.result).toBe('OUT_OF_SCOPE');
  });

  it('removes a planner entry', async () => {
    const entry = await prisma.sePlanner.findFirstOrThrow({ where: { seId: se, plantId } });
    const res = await planner.remove(String(entry.id), scope);
    expect(res.result).toBe('OK');
    const after = await prisma.sePlanner.findMany({ where: { seId: se } });
    expect(after).toHaveLength(0);
  });
});
