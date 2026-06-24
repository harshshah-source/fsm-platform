import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 24, slice 1 — the inventory ledger (`inventory_transactions`, LLD D12 / CONTEXT §Inventory).
 * Records component movement against a Ticket: `type` is the accounting category (TICKET_CONSUMPTION /
 * FAULTY_COMPONENT_RETURNED) and `status` is the lifecycle (PRE_VERIFICATION → DEDUCTED | ROLLED_BACK,
 * or SHADOW_USE → RECONCILED | DISPUTED). Asserts the FK chain and a status round-trip.
 */
const NS = Date.now();

describe('Issue 24 slice 1 — inventory_transactions schema', () => {
  let prisma: PrismaService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let componentId: bigint;
  let se: string;
  let deviceId: bigint;
  let ticketId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    zoneId = (await prisma.zone.create({ data: { name: 'Z-it-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-it-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-it-' + NS, zoneId } })).plantId;
    componentId = (await prisma.componentMaster.create({ data: { name: 'cmp-it-' + NS } })).componentId;
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({ data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'se-' + tag, email: `se-${tag}@it.test`, zoneId } });
    se = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
    deviceId = BigInt(12_500_000_000 + (NS % 1_000_000));
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: new Date() } });
    ticketId = (await prisma.ticket.create({ data: { workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: cycle.cycleId, deviceId, plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: new Date() } })).ticketId;
  });

  afterAll(async () => {
    await prisma.inventoryTransaction.deleteMany({ where: { ticketId } });
    await prisma.ticket.deleteMany({ where: { ticketId } });
    await prisma.failureCycle.deleteMany({ where: { deviceId } });
    await prisma.device.deleteMany({ where: { deviceId } });
    await prisma.componentMaster.deleteMany({ where: { componentId } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: se } });
    await prisma.user.deleteMany({ where: { userId: se } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  const fkExists = async (table: string, column: string, refTable: string): Promise<boolean> => {
    const rows = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = ${table}
        AND kcu.column_name = ${column} AND ccu.table_name = ${refTable}`;
    return Number(rows[0].n) >= 1;
  };

  it('has the FK chain to engineer / component / ticket', async () => {
    expect(await fkExists('inventory_transactions', 'se_id', 'engineer_master')).toBe(true);
    expect(await fkExists('inventory_transactions', 'component_id', 'component_master')).toBe(true);
    expect(await fkExists('inventory_transactions', 'ticket_id', 'tickets')).toBe(true);
  });

  it('round-trips a SHADOW_USE consumption row', async () => {
    const created = await prisma.inventoryTransaction.create({
      data: { seId: se, componentId, qty: 2, ticketId, type: 'TICKET_CONSUMPTION', status: 'SHADOW_USE', reason: 'lost 409' },
    });
    expect(created.status).toBe('SHADOW_USE');
    expect(created.type).toBe('TICKET_CONSUMPTION');
    const found = await prisma.inventoryTransaction.findUniqueOrThrow({ where: { id: created.id } });
    expect(found.qty).toBe(2);
  });
});
