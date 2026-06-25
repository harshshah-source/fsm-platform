import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { RecoveryService } from '../src/ticketing/recovery.service';
import type { RequestActor } from '../src/common/request-actor';

/**
 * Issue 36, slice 1 — Recovery Ticket field lifecycle (AC#1/#2). A RECOVERY ticket (created REQUESTED
 * by Issue 35) is scheduled to an SE, who marks ON_SITE then COLLECTED via the Collection Form: the
 * device serial is mandatory and validated against the ticket's device, and condition notes are
 * mandatory. Transitions are state-guarded and only the assigned SE may drive the field legs.
 */
const DEV = 9_360_001n;
const SE_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_SE = '22222222-2222-2222-2222-222222222222';

const zm: RequestActor = { userId: '33333333-3333-3333-3333-333333333333', role: 'ZONAL_MANAGER', actedAsRole: null, actingZone: null };
const se: RequestActor = { userId: SE_ID, role: 'SERVICE_ENGINEER', actedAsRole: null, actingZone: null };
const otherSe: RequestActor = { userId: OTHER_SE, role: 'SERVICE_ENGINEER', actedAsRole: null, actingZone: null };

describe('Issue 36 slice 1 — Recovery lifecycle schedule→on-site→collected', () => {
  let prisma: PrismaService;
  let service: RecoveryService;
  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;

  const newTicket = async () =>
    (
      await prisma.ticket.create({
        data: { workType: 'RECOVERY', status: 'REQUESTED', deviceId: DEV, plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: new Date() },
      })
    ).ticketId;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new RecoveryService(prisma, new AuditService(prisma));
    zoneId = (await prisma.zone.create({ data: { name: 'Z-rec-' + Date.now() } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-rec-' + Date.now(), companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-rec', zoneId } })).plantId;
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

  it('schedules → on-site → collected, validating serial + condition notes', async () => {
    const id = await newTicket();

    expect((await service.scheduleRecovery(id, SE_ID, zm)).result).toBe('OK');
    let t = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: id } });
    expect(t.status).toBe('SCHEDULED');
    expect(t.assignedSeId).toBe(SE_ID);

    expect((await service.markOnSite(id, se)).result).toBe('OK');
    expect((await prisma.ticket.findUniqueOrThrow({ where: { ticketId: id } })).status).toBe('ON_SITE');

    // wrong serial → INVALID_SERIAL; missing notes → NOTES_REQUIRED
    expect((await service.markCollected(id, { deviceSerial: '999', conditionNotes: 'ok' }, se)).result).toBe('INVALID_SERIAL');
    expect((await service.markCollected(id, { deviceSerial: String(DEV), conditionNotes: '  ' }, se)).result).toBe('NOTES_REQUIRED');

    const ok = await service.markCollected(id, { deviceSerial: String(DEV), conditionNotes: 'minor scratches' }, se);
    expect(ok.result).toBe('OK');
    t = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: id } });
    expect(t.status).toBe('COLLECTED');
    expect(t.collectedDeviceSerial).toBe(String(DEV));
    expect(t.collectionConditionNotes).toBe('minor scratches');

    const events = await prisma.ticketEvent.findMany({ where: { ticketId: id }, orderBy: { at: 'asc' } });
    expect(events.map((e) => e.toState)).toEqual(['SCHEDULED', 'ON_SITE', 'COLLECTED']);
  });

  it('guards transitions: wrong state, non-assigned SE, unknown ticket', async () => {
    const id = await newTicket();
    // can't go on-site before scheduling
    expect((await service.markOnSite(id, se)).result).toBe('WRONG_STATE');
    await service.scheduleRecovery(id, SE_ID, zm);
    // a different SE may not drive the field legs
    expect((await service.markOnSite(id, otherSe)).result).toBe('FORBIDDEN');
    // unknown ticket
    expect((await service.markOnSite('00000000-0000-0000-0000-0000000000aa', se)).result).toBe('NOT_FOUND');
  });
});
