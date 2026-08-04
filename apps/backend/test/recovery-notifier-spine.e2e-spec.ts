import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { NotificationService } from '../src/notifications/notification.service';
import { SpineRecoveryNotifier } from '../src/ticketing/recovery-notifier';

/**
 * #76 — adoption: `RecoveryNotifier`'s real port over the notification spine, replacing
 * `LoggingRecoveryNotifier` as the DI default (`ticketing.module.ts`). `recoveryClosed` has one
 * recipient (the SE); `unableToCollect` resolves the ticket's zone ZM (same lookup shape as
 * `IntradayInsertionService.escalateToZm`) since the event itself carries no zone. `escalatedToOh`
 * is deliberately NOT wired to the spine — no "notify Operations Head" recipient-resolution
 * precedent exists anywhere in this codebase (broadcast to all OH vs. a single designated OH is a
 * product decision), so it keeps logging exactly as `LoggingRecoveryNotifier` already did.
 */
describe('#76 — SpineRecoveryNotifier (adoption)', () => {
  let prisma: PrismaService;
  const userIds: string[] = [];
  const notificationIds: bigint[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let zmUserId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    const tag = randomUUID().slice(0, 8);
    const zm = await prisma.user.create({
      data: { name: 'ZM ' + tag, role: 'ZONAL_MANAGER', phone: 'rn-zm-' + tag, email: `rn-zm-${tag}@rn.test` },
    });
    zmUserId = zm.userId;
    userIds.push(zmUserId);
    zoneId = (await prisma.zone.create({ data: { name: 'Z-rn-' + tag, zonalManagerUserId: zmUserId } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-rn-' + tag, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-rn-' + tag, zoneId } })).plantId;
  });

  afterAll(async () => {
    await prisma.notificationDelivery.deleteMany({ where: { notificationId: { in: notificationIds } } });
    await prisma.notification.deleteMany({ where: { id: { in: notificationIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.onModuleDestroy();
  });

  async function makeSe(): Promise<string> {
    const t = randomUUID().slice(0, 8);
    const u = await prisma.user.create({ data: { name: 'SE ' + t, role: 'SERVICE_ENGINEER', phone: 'rn-' + t, email: `rn-${t}@rn.test` } });
    userIds.push(u.userId);
    return u.userId;
  }

  async function makeTicket(): Promise<string> {
    const deviceId = String(9_990_000_000 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    const ticket = await prisma.ticket.create({
      data: { workType: 'RECOVERY', status: 'ON_SITE', deviceId, plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: new Date() },
    });
    ticketIds.push(ticket.ticketId);
    return ticket.ticketId;
  }

  it('recoveryClosed notifies the assigned SE', async () => {
    const seId = await makeSe();
    const ticketId = await makeTicket();
    const notifier = new SpineRecoveryNotifier(new NotificationService(prisma), prisma);

    await notifier.recoveryClosed({ ticketId, deviceId: '9990000000', seId });

    const n = await prisma.notification.findFirstOrThrow({ where: { recipientUserId: seId, type: 'RECOVERY_CLOSED', entityId: ticketId } });
    notificationIds.push(n.id);
    expect(n.entityType).toBe('ticket');
  });

  it('recoveryClosed is a no-op when the ticket has no assigned SE', async () => {
    const ticketId = await makeTicket();
    const notifier = new SpineRecoveryNotifier(new NotificationService(prisma), prisma);

    await notifier.recoveryClosed({ ticketId, deviceId: '9990000000', seId: null });

    const n = await prisma.notification.findFirst({ where: { type: 'RECOVERY_CLOSED', entityId: ticketId } });
    expect(n).toBeNull();
  });

  it('unableToCollect notifies the ticket zone\'s ZM, resolved from the ticket (not passed in the event)', async () => {
    const seId = await makeSe();
    const ticketId = await makeTicket();
    const notifier = new SpineRecoveryNotifier(new NotificationService(prisma), prisma);

    await notifier.unableToCollect({ ticketId, deviceId: '9990000000', seId, reasonCode: 'VEHICLE_UNREACHABLE' });

    const n = await prisma.notification.findFirstOrThrow({
      where: { recipientUserId: zmUserId, type: 'RECOVERY_UNABLE_TO_COLLECT', entityId: ticketId },
    });
    notificationIds.push(n.id);
    expect(n.body).toContain('VEHICLE_UNREACHABLE');
  });
});
