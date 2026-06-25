import { PrismaService } from '../src/prisma/prisma.service';
import { RecoveryService } from '../src/ticketing/recovery.service';
import { AuditService } from '../src/audit/audit.service';
import { DashboardService } from '../src/dashboard/dashboard.service';

/**
 * Issue 37, slice 2 — stalled-recovery flag + non-standard closure compliance (AC#4/#5). Recovery
 * Tickets with no state progression for 14+ days surface in the ZM Action Required panel; every manual
 * closure (closure_type other than AUTO_CLOSED_ON_WAREHOUSE_RECEIPT) is listed as non-standard so it
 * never silently bypasses warehouse receipt.
 */
const DEV = 9_371_001n;

describe('Issue 37 slice 2 — stalled + non-standard closures', () => {
  let prisma: PrismaService;
  let service: RecoveryService;
  let dashboard: DashboardService;
  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  const ids: string[] = [];

  const NOW = new Date(Date.UTC(2026, 5, 25, 12, 0, 0));
  const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

  const ticket = async (data: Record<string, unknown>) => {
    const id = (await prisma.ticket.create({ data: { workType: 'RECOVERY', status: 'ON_SITE', deviceId: DEV, plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: NOW, ...data } })).ticketId;
    ids.push(id);
    return id;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new RecoveryService(prisma, new AuditService(prisma));
    dashboard = new DashboardService(prisma);
    zoneId = (await prisma.zone.create({ data: { name: 'Z-recs-' + Date.now() } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-recs-' + Date.now(), companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-recs', zoneId } })).plantId;
    await prisma.device.create({ data: { deviceId: DEV, dealType: 'RECURRING' } });
  });

  afterAll(async () => {
    await prisma.ticket.deleteMany({ where: { deviceId: DEV } });
    await prisma.device.deleteMany({ where: { deviceId: DEV } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('flags Recovery Tickets with no progression for 14+ days (not recent, not closed)', async () => {
    const stale = await ticket({ lastStateChangedAt: daysAgo(20) });
    await ticket({ lastStateChangedAt: daysAgo(2) }); // recent → excluded
    await ticket({ lastStateChangedAt: daysAgo(30), status: 'CLOSED', closureType: 'AUTO_CLOSED_ON_WAREHOUSE_RECEIPT', closedAt: daysAgo(30) }); // closed → excluded

    const stalled = await service.stalledRecoveries(NOW);
    const mine = stalled.filter((r) => ids.includes(r.ticketId));
    expect(mine.map((r) => r.ticketId)).toEqual([stale]);
  });

  it('surfaces the stalled count in the ZM Action Required panel', async () => {
    const cards = await dashboard.actionRequired({ role: 'OPERATIONS_HEAD', zoneId: null }, NOW);
    const card = cards.find((c) => c.key === 'recovery_stalled');
    expect(card).toBeDefined();
    expect(card!.available).toBe(true);
    expect(card!.count).toBeGreaterThanOrEqual(1);
  });

  it('lists manual closures as non-standard (auto receipt closures excluded)', async () => {
    await ticket({ status: 'CLOSED', closureType: 'ZM_MANUAL_CLOSE', closureReason: 'lost', closedAt: NOW });
    await ticket({ status: 'CLOSED', closureType: 'AUTO_CLOSED_ON_WAREHOUSE_RECEIPT', closedAt: NOW });

    const nonStandard = await service.nonStandardClosures();
    const mine = nonStandard.filter((r) => ids.includes(r.ticketId));
    expect(mine.every((r) => r.closureType !== 'AUTO_CLOSED_ON_WAREHOUSE_RECEIPT')).toBe(true);
    expect(mine.some((r) => r.closureType === 'ZM_MANUAL_CLOSE')).toBe(true);
  });
});
