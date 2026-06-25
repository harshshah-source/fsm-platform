import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { RecoveryService } from '../src/ticketing/recovery.service';
import type { RecoveryClosedEvent, RecoveryNotifier, RecoveryUnableToCollectEvent } from '../src/ticketing/recovery-notifier';
import type { RequestActor } from '../src/common/request-actor';

/**
 * Issue 36, slice 2 — warehouse receipt auto-close + closure notification + unable-to-collect
 * (AC#3/#4/#5). The Warehouse Manager confirming receipt of a COLLECTED device auto-closes the ticket
 * (`AUTO_CLOSED_ON_WAREHOUSE_RECEIPT`, no ZM approval) and notifies SE + ZM. The SE tapping Unable to
 * Collect with a mandatory reason routes the ticket to the ZM decision queue (Issue 37).
 */
const DEV = 9_361_001n;
const SE_ID = '11111111-1111-1111-1111-111111111111';

const zm: RequestActor = { userId: '33333333-3333-3333-3333-333333333333', role: 'ZONAL_MANAGER', actedAsRole: null, actingZone: null };
const se: RequestActor = { userId: SE_ID, role: 'SERVICE_ENGINEER', actedAsRole: null, actingZone: null };
const wm: RequestActor = { userId: '44444444-4444-4444-4444-444444444444', role: 'WAREHOUSE_MANAGER', actedAsRole: null, actingZone: null };

describe('Issue 36 slice 2 — receipt auto-close + unable-to-collect', () => {
  let prisma: PrismaService;
  let service: RecoveryService;
  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  const closed: RecoveryClosedEvent[] = [];
  const unable: RecoveryUnableToCollectEvent[] = [];
  const notifier: RecoveryNotifier = {
    recoveryClosed: (e) => { closed.push(e); },
    unableToCollect: (e) => { unable.push(e); },
  };

  const collectedTicket = async () => {
    const id = (await prisma.ticket.create({ data: { workType: 'RECOVERY', status: 'REQUESTED', deviceId: DEV, plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: new Date() } })).ticketId;
    await service.scheduleRecovery(id, SE_ID, zm);
    await service.markOnSite(id, se);
    await service.markCollected(id, { deviceSerial: String(DEV), conditionNotes: 'ok' }, se);
    return id;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new RecoveryService(prisma, new AuditService(prisma), notifier);
    zoneId = (await prisma.zone.create({ data: { name: 'Z-rec2-' + Date.now() } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-rec2-' + Date.now(), companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-rec2', zoneId } })).plantId;
    await prisma.device.create({ data: { deviceId: DEV, dealType: 'RECURRING' } });
  });

  afterAll(async () => {
    await prisma.ticketEvent.deleteMany({ where: { ticket: { deviceId: DEV } } });
    await prisma.ticket.deleteMany({ where: { deviceId: DEV } });
    await prisma.device.deleteMany({ where: { deviceId: DEV } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('WM receipt auto-closes the ticket and notifies SE + ZM', async () => {
    const id = await collectedTicket();
    closed.length = 0;

    const ok = await service.confirmWarehouseReceipt(id, wm);
    expect(ok.result).toBe('OK');
    const t = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: id } });
    expect(t.status).toBe('CLOSED');
    expect(t.closureType).toBe('AUTO_CLOSED_ON_WAREHOUSE_RECEIPT');
    expect(t.closedAt).not.toBeNull();

    const events = await prisma.ticketEvent.findMany({ where: { ticketId: id }, orderBy: { at: 'asc' } });
    expect(events.map((e) => e.toState).slice(-2)).toEqual(['RECEIVED_AT_WAREHOUSE', 'CLOSED']);
    expect(closed).toHaveLength(1);
    expect(closed[0].ticketId).toBe(id);
  });

  it('lists COLLECTED recovery tickets awaiting warehouse receipt', async () => {
    const id = await collectedTicket();
    const list = await service.awaitingReceipt();
    expect(list.some((r) => r.ticketId === id && r.status === 'COLLECTED')).toBe(true);
  });

  it('only the Warehouse Manager may confirm receipt, and only when COLLECTED', async () => {
    const id = await collectedTicket();
    expect((await service.confirmWarehouseReceipt(id, zm)).result).toBe('FORBIDDEN');

    const fresh = (await prisma.ticket.create({ data: { workType: 'RECOVERY', status: 'REQUESTED', deviceId: DEV, plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: new Date() } })).ticketId;
    expect((await service.confirmWarehouseReceipt(fresh, wm)).result).toBe('WRONG_STATE');
  });

  it('Unable to Collect requires a reason and routes to the ZM decision queue', async () => {
    const id = (await prisma.ticket.create({ data: { workType: 'RECOVERY', status: 'REQUESTED', deviceId: DEV, plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: new Date() } })).ticketId;
    await service.scheduleRecovery(id, SE_ID, zm);
    await service.markOnSite(id, se);
    unable.length = 0;

    // @ts-expect-error — invalid reason guarded at runtime
    expect((await service.markUnableToCollect(id, { reasonCode: '' }, se)).result).toBe('INVALID_REASON');

    const ok = await service.markUnableToCollect(id, { reasonCode: 'COMPANY_REFUSED' }, se);
    expect(ok.result).toBe('OK');
    const t = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: id } });
    expect(t.unableToCollectReason).toBe('COMPANY_REFUSED');
    expect(t.unableToCollectAt).not.toBeNull();
    expect(unable).toHaveLength(1);

    const queue = await service.zmDecisionQueue();
    expect(queue.some((r) => r.ticketId === id)).toBe(true);
  });
});
