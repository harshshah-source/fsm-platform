import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { RecoveryService } from '../src/ticketing/recovery.service';
import type { RecoveryEscalatedEvent, RecoveryNotifier } from '../src/ticketing/recovery-notifier';
import type { RequestActor } from '../src/common/request-actor';

/**
 * Issue 37, slice 1 — ZM decision-queue actions + manual closure authority (AC#1/#2/#3). An
 * unable-to-collect Recovery Ticket can be rescheduled, closed as FAILED_RECOVERY (mandatory reason),
 * or escalated to Operations Head. Manual closure records the closure type by acting role
 * (ZM_MANUAL_CLOSE / OPERATIONS_HEAD_OVERRIDE_CLOSE / CSM_ACTING_CLOSE) with full audit fields.
 */
const DEV = 9_370_001n;
const SE_ID = '11111111-1111-1111-1111-111111111111';
const SE2 = '99999999-9999-9999-9999-999999999999';

const zm: RequestActor = { userId: '33333333-3333-3333-3333-333333333333', role: 'ZONAL_MANAGER', actedAsRole: null, actingZone: null };
const oh: RequestActor = { userId: '44444444-4444-4444-4444-444444444444', role: 'OPERATIONS_HEAD', actedAsRole: null, actingZone: null };
const csm: RequestActor = { userId: '55555555-5555-5555-5555-555555555555', role: 'CENTRAL_SERVICE_MANAGER', actedAsRole: 'CENTRAL_SERVICE_MANAGER', actingZone: 1 };
const se: RequestActor = { userId: SE_ID, role: 'SERVICE_ENGINEER', actedAsRole: null, actingZone: null };

describe('Issue 37 slice 1 — decision-queue actions + manual close', () => {
  let prisma: PrismaService;
  let service: RecoveryService;
  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  const escalations: RecoveryEscalatedEvent[] = [];
  const notifier: RecoveryNotifier = {
    recoveryClosed: () => {},
    unableToCollect: () => {},
    escalatedToOh: (e) => { escalations.push(e); },
  };

  /** A recovery ticket flagged unable-to-collect (sitting in the ZM decision queue). */
  const unableTicket = async () => {
    const id = (await prisma.ticket.create({ data: { workType: 'RECOVERY', status: 'REQUESTED', deviceId: DEV, plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: new Date() } })).ticketId;
    await service.scheduleRecovery(id, SE_ID, zm);
    await service.markOnSite(id, se);
    await service.markUnableToCollect(id, { reasonCode: 'COMPANY_REFUSED' }, se);
    return id;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new RecoveryService(prisma, new AuditService(prisma), notifier);
    zoneId = (await prisma.zone.create({ data: { name: 'Z-recd-' + Date.now() } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-recd-' + Date.now(), companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-recd', zoneId } })).plantId;
    await prisma.device.create({ data: { deviceId: DEV, dealType: 'RECURRING' } });
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { entityType: 'tickets' } });
    await prisma.ticketEvent.deleteMany({ where: { ticket: { deviceId: DEV } } });
    await prisma.ticket.deleteMany({ where: { deviceId: DEV } });
    await prisma.device.deleteMany({ where: { deviceId: DEV } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('reschedule re-assigns the SE and clears the unable flag (back to SCHEDULED)', async () => {
    const id = await unableTicket();
    expect((await service.rescheduleRecovery(id, SE2, zm)).result).toBe('OK');
    const t = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: id } });
    expect(t.status).toBe('SCHEDULED');
    expect(t.assignedSeId).toBe(SE2);
    expect(t.unableToCollectReason).toBeNull();
    expect((await service.zmDecisionQueue()).some((r) => r.ticketId === id)).toBe(false);
  });

  it('close as FAILED_RECOVERY needs a reason and sets the closure type', async () => {
    const id = await unableTicket();
    expect((await service.closeFailedRecovery(id, '  ', zm)).result).toBe('REASON_REQUIRED');
    expect((await service.closeFailedRecovery(id, 'customer scrapped vehicle', zm)).result).toBe('OK');
    const t = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: id } });
    expect(t.status).toBe('FAILED_RECOVERY');
    expect(t.closureType).toBe('FAILED_RECOVERY_CLOSE');
    expect(t.closureReason).toBe('customer scrapped vehicle');
    expect(t.closedAt).not.toBeNull();
  });

  it('escalate notifies Operations Head', async () => {
    const id = await unableTicket();
    escalations.length = 0;
    expect((await service.escalateToOh(id, zm)).result).toBe('OK');
    expect(escalations).toHaveLength(1);
    expect(escalations[0].ticketId).toBe(id);
  });

  it('manual close records closure type by acting role + full audit, OH closes any zone', async () => {
    const idZm = await unableTicket();
    expect((await service.manualClose(idZm, 'lost device', zm)).result).toBe('OK');
    let t = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: idZm } });
    expect(t.status).toBe('CLOSED');
    expect(t.closureType).toBe('ZM_MANUAL_CLOSE');

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'tickets', entityId: idZm, action: 'RECOVERY_MANUAL_CLOSE' } });
    const meta = audit.metadata as { previousState?: string; deviceSerial?: string; closureType?: string };
    expect(meta.previousState).toBe('ON_SITE');
    expect(meta.deviceSerial).toBe(String(DEV));

    const idOh = await unableTicket();
    expect((await service.manualClose(idOh, 'override', oh)).result).toBe('OK');
    expect((await prisma.ticket.findUniqueOrThrow({ where: { ticketId: idOh } })).closureType).toBe('OPERATIONS_HEAD_OVERRIDE_CLOSE');

    const idCsm = await unableTicket();
    expect((await service.manualClose(idCsm, 'acting close', csm)).result).toBe('OK');
    expect((await prisma.ticket.findUniqueOrThrow({ where: { ticketId: idCsm } })).closureType).toBe('CSM_ACTING_CLOSE');
  });

  it('a Service Engineer cannot drive decision-queue actions', async () => {
    const id = await unableTicket();
    expect((await service.rescheduleRecovery(id, SE2, se)).result).toBe('FORBIDDEN');
    expect((await service.closeFailedRecovery(id, 'x', se)).result).toBe('FORBIDDEN');
    expect((await service.manualClose(id, 'x', se)).result).toBe('FORBIDDEN');
  });
});
