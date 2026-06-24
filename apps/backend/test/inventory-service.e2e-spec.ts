import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { InventoryService } from '../src/inventory/inventory.service';

/**
 * Issue 21, slice 2 — Van Stock reads + Common-Kit completeness. `commonKitStatus` compares each
 * active common_kit_definition component against the SE's van stock; an SE short on any kit item is
 * incomplete with the shortfall listed. No kit definition ⇒ trivially complete.
 */
const NS = Date.now();

describe('Issue 21 slice 2 — InventoryService', () => {
  let prisma: PrismaService;
  let svc: InventoryService;

  let zoneId: bigint;
  let cable: bigint;
  let sim: bigint;
  let se: string;
  const kitIds: bigint[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new InventoryService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-inv-' + NS } })).zoneId;
    cable = (await prisma.componentMaster.create({ data: { name: 'Cable-' + NS } })).componentId;
    sim = (await prisma.componentMaster.create({ data: { name: 'SIM-' + NS } })).componentId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@inv.test`, zoneId },
    });
    se = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
  });

  afterAll(async () => {
    await prisma.commonKitDefinition.deleteMany({ where: { componentId: { in: [cable, sim] } } });
    await prisma.seVanStock.deleteMany({ where: { seId: se } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: se } });
    await prisma.user.deleteMany({ where: { userId: se } });
    await prisma.componentMaster.deleteMany({ where: { componentId: { in: [cable, sim] } } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('treats an SE with no van stock as complete (inventory not yet tracked)', async () => {
    // Even with a kit configured globally, an untracked SE (no van-stock rows) is not grounded.
    expect((await svc.commonKitStatus(se)).complete).toBe(true);
  });

  it('lists Van Stock with quantities', async () => {
    await prisma.seVanStock.create({ data: { seId: se, componentId: cable, qty: 3 } });
    const stock = await svc.vanStockFor(se);
    const cableRow = stock.find((s) => s.componentId === String(cable));
    expect(cableRow?.qty).toBe(3);
  });

  it('is incomplete and lists the shortfall when a tracked SE is below a kit item min_qty', async () => {
    kitIds.push((await prisma.commonKitDefinition.create({ data: { componentId: cable, minQty: 1 } })).id);
    kitIds.push((await prisma.commonKitDefinition.create({ data: { componentId: sim, minQty: 2 } })).id);
    // SE has 3 cables (ok) but no SIMs (needs 2) → incomplete, SIM listed (assert by presence; the
    // global kit may carry unrelated items from concurrent suites).
    const status = await svc.commonKitStatus(se);
    expect(status.complete).toBe(false);
    const simMissing = status.missing.find((m) => m.componentId === String(sim));
    expect(simMissing?.shortBy).toBe(2);
  });

  it('drops a kit item from the shortfall once it meets its min_qty', async () => {
    await prisma.seVanStock.create({ data: { seId: se, componentId: sim, qty: 2 } });
    const status = await svc.commonKitStatus(se);
    expect(status.missing.find((m) => m.componentId === String(sim))).toBeUndefined();
  });
});
