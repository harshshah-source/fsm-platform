import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { ShadowUseService } from '../src/inventory/shadow-use.service';

/**
 * Issue 24, slice 4 — the Shadow Use Queue (CONTEXT §Shadow Use Queue). The Warehouse Manager sees
 * unreconciled SHADOW_USE inventory rows and marks each RECONCILED (genuine duplicate effort) or
 * DISPUTED (mismatch — escalates to the ZM and flags the Ticket with an Inventory Dispute event).
 */
const NS = Date.now();
const NOW = new Date('2026-06-24T09:00:00Z');

describe('Issue 24 slice 4 — shadow use queue (WM reconciliation)', () => {
  let prisma: PrismaService;
  let svc: ShadowUseService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let componentId: bigint;
  let se: string;
  let wm: string;
  const deviceIds: bigint[] = [];
  const ticketIds: string[] = [];
  const wmActor = () => ({ userId: wm, role: 'WAREHOUSE_MANAGER' });

  const seedShadow = async (): Promise<{ id: string; ticketId: string }> => {
    const deviceId = BigInt(12_800_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'SUBMITTED', openedAt: NOW } });
    const ticket = await prisma.ticket.create({ data: { workType: 'TROUBLESHOOT', status: 'VERIFICATION_PENDING', failureCycleId: cycle.cycleId, deviceId, plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: NOW } });
    ticketIds.push(ticket.ticketId);
    const txn = await prisma.inventoryTransaction.create({
      data: { seId: se, componentId, qty: 1, ticketId: ticket.ticketId, type: 'TICKET_CONSUMPTION', status: 'SHADOW_USE', reason: 'BUSINESS_409_SHADOW_USE' },
    });
    return { id: String(txn.id), ticketId: ticket.ticketId };
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new ShadowUseService(prisma);
    zoneId = (await prisma.zone.create({ data: { name: 'Z-suq-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-suq-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-suq-' + NS, zoneId } })).plantId;
    componentId = (await prisma.componentMaster.create({ data: { name: 'cmp-suq-' + NS } })).componentId;
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({ data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'se-' + tag, email: `se-${tag}@suq.test`, zoneId } });
    se = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
    wm = (await prisma.user.create({ data: { name: 'WM ' + tag, role: 'WAREHOUSE_MANAGER', phone: 'wm-' + tag, email: `wm-${tag}@suq.test`, zoneId } })).userId;
  });

  afterAll(async () => {
    await prisma.inventoryTransaction.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.auditLog.deleteMany({ where: { entityType: 'inventory_transactions' } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.componentMaster.deleteMany({ where: { componentId } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: se } });
    await prisma.user.deleteMany({ where: { userId: { in: [se, wm] } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('lists unreconciled SHADOW_USE rows with context', async () => {
    const { id } = await seedShadow();
    const rows = await svc.queue();
    const row = rows.find((r) => r.id === id)!;
    expect(row).toBeTruthy();
    expect(row.componentName).toBe('cmp-suq-' + NS);
    expect(row.status).toBe('SHADOW_USE');
    expect(row.qty).toBe(1);
  });

  it('marks a row RECONCILED', async () => {
    const { id } = await seedShadow();
    const out = await svc.markReconciled(id, wmActor());
    expect(out.result).toBe('OK');
    const row = await prisma.inventoryTransaction.findUniqueOrThrow({ where: { id: BigInt(id) } });
    expect(row.status).toBe('RECONCILED');
    expect(row.reconciledBy).toBe(wm);
  });

  it('marks a row DISPUTED, escalates, and flags the ticket with an Inventory Dispute event', async () => {
    const { id, ticketId } = await seedShadow();
    const out = await svc.markDisputed(id, 'winning SE reported using this part', wmActor());
    expect(out.result).toBe('OK');
    const row = await prisma.inventoryTransaction.findUniqueOrThrow({ where: { id: BigInt(id) } });
    expect(row.status).toBe('DISPUTED');
    const flag = await prisma.ticketEvent.findFirst({ where: { ticketId, reasonCode: 'INVENTORY_DISPUTE' } });
    expect(flag).toBeTruthy();
  });

  it('refuses to reconcile a row that is not SHADOW_USE', async () => {
    const { id } = await seedShadow();
    await svc.markReconciled(id, wmActor());
    const again = await svc.markReconciled(id, wmActor());
    expect(again.result).toBe('INVALID_STATE');
  });
});
