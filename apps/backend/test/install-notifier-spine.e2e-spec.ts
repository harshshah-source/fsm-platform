import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { NotificationService } from '../src/notifications/notification.service';
import { SpineInstallNotifier } from '../src/ticketing/install-notifier';

/**
 * #76 — adoption: `InstallNotifier`'s real port over the notification spine, replacing
 * `LoggingInstallNotifier` as the DI default (`ticketing.module.ts`). Both events have exactly one
 * recipient — the assigned SE.
 */
describe('#76 — SpineInstallNotifier (adoption)', () => {
  let prisma: PrismaService;
  const userIds: string[] = [];
  const notificationIds: bigint[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.notificationDelivery.deleteMany({ where: { notificationId: { in: notificationIds } } });
    await prisma.notification.deleteMany({ where: { id: { in: notificationIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.onModuleDestroy();
  });

  async function makeSe(): Promise<string> {
    const t = randomUUID().slice(0, 8);
    const u = await prisma.user.create({ data: { name: 'SE ' + t, role: 'SERVICE_ENGINEER', phone: 'in-' + t, email: `in-${t}@in.test` } });
    userIds.push(u.userId);
    return u.userId;
  }

  it('installVerified notifies the SE the ticket closed', async () => {
    const seId = await makeSe();
    const notifier = new SpineInstallNotifier(new NotificationService(prisma));

    await notifier.installVerified({ ticketId: 't-install-1', deviceId: 'd-1', seId });

    const n = await prisma.notification.findFirstOrThrow({ where: { recipientUserId: seId, type: 'INSTALL_VERIFIED', entityId: 't-install-1' } });
    notificationIds.push(n.id);
    expect(n.entityType).toBe('ticket');
  });

  it('failedActivation notifies the SE with the same copy the #71 mobile card uses', async () => {
    const seId = await makeSe();
    const notifier = new SpineInstallNotifier(new NotificationService(prisma));

    await notifier.failedActivation({ ticketId: 't-install-2', deviceId: 'd-2', seId });

    const n = await prisma.notification.findFirstOrThrow({ where: { recipientUserId: seId, type: 'INSTALL_FAILED_ACTIVATION', entityId: 't-install-2' } });
    notificationIds.push(n.id);
    expect(n.body).toBe('No GPS ping received — activation failed.');
  });

  it('is a no-op when the ticket has no assigned SE', async () => {
    const notifier = new SpineInstallNotifier(new NotificationService(prisma));

    await notifier.installVerified({ ticketId: 't-install-3', deviceId: 'd-3', seId: null });

    const n = await prisma.notification.findFirst({ where: { type: 'INSTALL_VERIFIED', entityId: 't-install-3' } });
    expect(n).toBeNull();
  });
});
