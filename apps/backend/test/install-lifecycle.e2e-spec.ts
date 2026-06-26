import { randomUUID } from 'node:crypto';
import type { RequestActor } from '../src/common/request-actor';
import { AuditService } from '../src/audit/audit.service';
import { InstallLifecycleService } from '../src/ticketing/install-lifecycle.service';
import { LoggingInstallNotifier } from '../src/ticketing/install-notifier';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 34 — Install lifecycle (AC#1, AC#2). The SE field workflow on an INSTALL ticket:
 * REQUESTED → SCHEDULED (manager dispatch) → ON_SITE (assigned SE) → FITTED → ACTIVATED (the Install
 * Form: mandatory GPS device serial + SIM serial, optional photo; `activated_at` anchors warranty and
 * starts auto-verification). Every transition is state-guarded, audited, and appends a ticket_events
 * row. The verification sweep (first valid ping → CLOSED / window → FAILED_ACTIVATION) is its own spec.
 */
const NS = Date.now();

const seId = randomUUID();
const otherSeId = randomUUID();
const zmActor: RequestActor = { userId: randomUUID(), role: 'ZONAL_MANAGER', actedAsRole: null, actingZone: null };
const seActor: RequestActor = { userId: seId, role: 'SERVICE_ENGINEER', actedAsRole: null, actingZone: null };
const otherSeActor: RequestActor = { userId: otherSeId, role: 'SERVICE_ENGINEER', actedAsRole: null, actingZone: null };

describe('Issue 34 — InstallLifecycleService transitions', () => {
  let prisma: PrismaService;
  let service: InstallLifecycleService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let vehicleId: bigint;
  let deviceSeq = 9_340_000n;
  const createdTicketIds: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new InstallLifecycleService(prisma, new AuditService(prisma), new LoggingInstallNotifier());

    zoneId = (await prisma.zone.create({ data: { name: 'Z-il-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-il-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-il-' + NS, zoneId } })).plantId;
    vehicleId = (await prisma.vehicle.create({ data: { vehicleNo: 'IL-VEH-' + NS, plantId, companyId } })).vehicleId;
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { entityType: 'tickets', entityId: { in: createdTicketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: createdTicketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: createdTicketIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { gte: 9_340_000n, lt: 9_341_000n } } });
    await prisma.vehicle.deleteMany({ where: { vehicleId } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  /** Create a fresh INSTALL ticket at a given status with its own device. */
  const makeTicket = async (status: 'REQUESTED' | 'SCHEDULED' | 'ON_SITE', assigned: string | null): Promise<{ ticketId: string; deviceId: bigint }> => {
    const deviceId = deviceSeq++;
    await prisma.device.create({ data: { deviceId, deviceType: 'GPS-X' } });
    const t = await prisma.ticket.create({
      data: {
        workType: 'INSTALL',
        status,
        deviceId,
        vehicleId,
        plantId,
        companyId,
        companyTier: 'GOLD',
        installTriggerSource: 'MANUAL_OPERATIONS',
        assignedSeId: assigned,
        lastStateChangedAt: new Date(),
      },
    });
    createdTicketIds.push(t.ticketId);
    return { ticketId: t.ticketId, deviceId };
  };

  // ---- schedule: REQUESTED → SCHEDULED ----

  it('a manager schedules a REQUESTED install to an SE → SCHEDULED + assignedSe + event', async () => {
    const { ticketId } = await makeTicket('REQUESTED', null);
    const out = await service.scheduleInstall(ticketId, seId, zmActor);
    expect(out.result).toBe('OK');
    const t = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    expect(t.status).toBe('SCHEDULED');
    expect(t.assignedSeId).toBe(seId);
    const ev = await prisma.ticketEvent.findFirst({ where: { ticketId, toState: 'SCHEDULED' } });
    expect(ev?.fromState).toBe('REQUESTED');
  });

  it('forbids a non-manager from scheduling', async () => {
    const { ticketId } = await makeTicket('REQUESTED', null);
    expect((await service.scheduleInstall(ticketId, seId, seActor)).result).toBe('FORBIDDEN');
  });

  it('rejects scheduling a non-REQUESTED ticket (wrong state)', async () => {
    const { ticketId } = await makeTicket('ON_SITE', seId);
    expect((await service.scheduleInstall(ticketId, seId, zmActor)).result).toBe('WRONG_STATE');
  });

  it('returns NOT_FOUND for an unknown ticket', async () => {
    expect((await service.scheduleInstall(randomUUID(), seId, zmActor)).result).toBe('NOT_FOUND');
  });

  // ---- on-site: SCHEDULED → ON_SITE ----

  it('the assigned SE marks on-site → ON_SITE', async () => {
    const { ticketId } = await makeTicket('SCHEDULED', seId);
    const out = await service.markOnSite(ticketId, seActor);
    expect(out.result).toBe('OK');
    const t = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    expect(t.status).toBe('ON_SITE');
  });

  it('forbids an SE who is not the assigned SE from marking on-site', async () => {
    const { ticketId } = await makeTicket('SCHEDULED', seId);
    expect((await service.markOnSite(ticketId, otherSeActor)).result).toBe('FORBIDDEN');
  });

  // ---- fitted form: ON_SITE → FITTED → ACTIVATED ----

  it('the assigned SE submits the Install Form → FITTED then ACTIVATED, serials + photo + anchors persisted', async () => {
    const { ticketId, deviceId } = await makeTicket('ON_SITE', seId);
    const now = new Date(Date.UTC(2026, 5, 26, 10, 0, 0));
    const out = await service.markFitted(
      ticketId,
      { gpsDeviceSerial: String(deviceId), simSerial: 'SIM-IL-1', photoRef: 'photos/il-1.jpg' },
      seActor,
      now,
    );
    expect(out.result).toBe('OK');
    const t = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    expect(t.status).toBe('ACTIVATED');
    expect(t.fittedGpsSerial).toBe(String(deviceId));
    expect(t.fittedSimSerial).toBe('SIM-IL-1');
    expect(t.fittedPhotoRef).toBe('photos/il-1.jpg');
    expect(t.fittedAt?.toISOString()).toBe(now.toISOString());
    expect(t.activatedAt?.toISOString()).toBe(now.toISOString());
    // Both lifecycle legs recorded.
    const states = (await prisma.ticketEvent.findMany({ where: { ticketId }, orderBy: { at: 'asc' } })).map((e) => e.toState);
    expect(states).toContain('FITTED');
    expect(states).toContain('ACTIVATED');
  });

  it('photo is optional — fitment succeeds without it', async () => {
    const { ticketId, deviceId } = await makeTicket('ON_SITE', seId);
    const out = await service.markFitted(ticketId, { gpsDeviceSerial: String(deviceId), simSerial: 'SIM-IL-2' }, seActor);
    expect(out.result).toBe('OK');
    expect((await prisma.ticket.findUniqueOrThrow({ where: { ticketId } })).fittedPhotoRef).toBeNull();
  });

  it('rejects fitment with a missing SIM serial', async () => {
    const { ticketId, deviceId } = await makeTicket('ON_SITE', seId);
    expect((await service.markFitted(ticketId, { gpsDeviceSerial: String(deviceId), simSerial: '  ' }, seActor)).result).toBe('SERIAL_REQUIRED');
  });

  it('rejects fitment when the GPS serial does not match the ticket device', async () => {
    const { ticketId } = await makeTicket('ON_SITE', seId);
    expect((await service.markFitted(ticketId, { gpsDeviceSerial: 'WRONG-SERIAL', simSerial: 'SIM-IL-3' }, seActor)).result).toBe('INVALID_SERIAL');
  });

  it('forbids fitment by a non-assigned SE and rejects a non-ON_SITE ticket', async () => {
    const onSite = await makeTicket('ON_SITE', seId);
    expect((await service.markFitted(onSite.ticketId, { gpsDeviceSerial: String(onSite.deviceId), simSerial: 'X' }, otherSeActor)).result).toBe('FORBIDDEN');
    const scheduled = await makeTicket('SCHEDULED', seId);
    expect((await service.markFitted(scheduled.ticketId, { gpsDeviceSerial: String(scheduled.deviceId), simSerial: 'X' }, seActor)).result).toBe('WRONG_STATE');
  });
});
