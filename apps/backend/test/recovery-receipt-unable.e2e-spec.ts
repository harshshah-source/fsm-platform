import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { RecoveryService } from '../src/ticketing/recovery.service';
import type { RecoveryClosedEvent, RecoveryNotifier, RecoveryUnableToCollectEvent } from '../src/ticketing/recovery-notifier';
import type { RequestActor } from '../src/common/request-actor';
import {
  RECOVERY_CLOSED_EVENT_TYPE,
  RECOVERY_UNABLE_TO_COLLECT_EVENT_TYPE,
  drainRows,
} from '../src/scheduling/day-plan-notification-outbox';
import { EnqueueFailed, failingNotifyEnqueue, inertDayPlanNotifier } from './fixtures/outbox-crash-injection';

/**
 * Issue 36, slice 2 — warehouse receipt auto-close + closure notification + unable-to-collect
 * (AC#3/#4/#5). The Warehouse Manager confirming receipt of a COLLECTED device auto-closes the ticket
 * (`AUTO_CLOSED_ON_WAREHOUSE_RECEIPT`, no ZM approval) and notifies SE + ZM. The SE tapping Unable to
 * Collect with a mandatory reason routes the ticket to the ZM decision queue (Issue 37).
 */
const DEV = String(9_361_001n);
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

  /**
   * #338 — the recovery notices are outbox rows, delivered through `RecoveryNotifier`.
   *
   * Both fired after `withAudit`'s transaction had committed: a crash in the gap closed a recovery
   * ticket without telling the engineer, or routed one to the ZM decision queue with the ZM never
   * told — and a throwing port turned a committed write into a 500 for the Warehouse Manager who had
   * already done the thing.
   *
   * Delivered through the port, not flattened into a resolved notice: `SpineRecoveryNotifier`
   * resolves the ZM by ticket → plant → zone, and `escalatedToOh` deliberately notifies nobody. The
   * spy above still sees both events — it is now the drain that calls it.
   */
  describe('#338 — the recovery notices are outbox rows delivered through the port', () => {
    const dead: RecoveryNotifier = {
      recoveryClosed: () => { throw new Error('injected: the recovery push failed'); },
      unableToCollect: () => { throw new Error('injected: the recovery push failed'); },
    };

    const rowsOfType = async (eventType: string, ticketId: string) => {
      const rows = await prisma.dayPlanNotificationOutbox.findMany({ where: { eventType }, orderBy: { id: 'asc' } });
      return rows.filter((r) => (r.payload as { ticketId?: string } | null)?.ticketId === ticketId);
    };

    it('a port that throws leaves the ticket CLOSED and the notice retryable', async () => {
      const id = await collectedTicket();
      closed.length = 0;

      const service = new RecoveryService(prisma, new AuditService(prisma), dead);
      expect((await service.confirmWarehouseReceipt(id, wm)).result).toBe('OK');
      expect((await prisma.ticket.findUniqueOrThrow({ where: { ticketId: id } })).status).toBe('CLOSED');

      const rows = await rowsOfType(RECOVERY_CLOSED_EVENT_TYPE, id);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.sentAt).toBeNull();
      expect(row.lastError).toMatch(/injected/);
      expect(closed).toHaveLength(0);

      await drainRows(prisma, inertDayPlanNotifier, [row.id], new Date(), { recovery: notifier });
      expect(closed.filter((e) => e.ticketId === id)).toHaveLength(1);
      await drainRows(prisma, inertDayPlanNotifier, [row.id], new Date(), { recovery: notifier });
      expect(closed.filter((e) => e.ticketId === id)).toHaveLength(1);
      await prisma.dayPlanNotificationOutbox.deleteMany({ where: { id: row.id } });
    });

    it('a failed enqueue rolls the warehouse receipt back — no silent close', async () => {
      const id = await collectedTicket();
      // Both services over the SAME interfering client: `withAudit` opens the transaction on the
      // `AuditService`'s own connection, so a proxy given only to `RecoveryService` never sees it
      // (#325's spec records the same trap).
      const interfering = failingNotifyEnqueue(prisma);
      const service = new RecoveryService(interfering, new AuditService(interfering), notifier);

      await expect(service.confirmWarehouseReceipt(id, wm)).rejects.toThrow(EnqueueFailed);

      const t = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: id } });
      expect(t.status).toBe('COLLECTED');
      expect(t.closedAt).toBeNull();
      expect(await prisma.ticketEvent.count({ where: { ticketId: id, toState: 'CLOSED' } })).toBe(0);
      expect(await rowsOfType(RECOVERY_CLOSED_EVENT_TYPE, id)).toHaveLength(0);
    });

    it("unable-to-collect's ZM notice commits with the flag that routes the ticket", async () => {
      const id = await collectedTicket();
      // Back to ON_SITE is not a transition this service offers, so the unable-to-collect door is
      // reached on a fresh ticket taken only as far as ON_SITE.
      const fresh = (await prisma.ticket.create({
        data: { workType: 'RECOVERY', status: 'REQUESTED', deviceId: DEV, plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: new Date() },
      })).ticketId;
      await service.scheduleRecovery(fresh, SE_ID, zm);
      await service.markOnSite(fresh, se);

      const interfering = failingNotifyEnqueue(prisma);
      const failing = new RecoveryService(interfering, new AuditService(interfering), notifier);
      await expect(
        failing.markUnableToCollect(fresh, { reasonCode: 'DEVICE_MISSING' }, se),
      ).rejects.toThrow(EnqueueFailed);

      const t = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: fresh } });
      expect(t.unableToCollectReason).toBeNull();
      expect(t.unableToCollectAt).toBeNull();
      expect(await rowsOfType(RECOVERY_UNABLE_TO_COLLECT_EVENT_TYPE, fresh)).toHaveLength(0);
      expect(id).toBeTruthy();
    });
  });
});
