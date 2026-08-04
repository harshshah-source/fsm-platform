import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { NotificationService } from '../src/notifications/notification.service';
import { SpineDayPlanNotifier } from '../src/scheduling/day-plan-notifier';

/**
 * #76 — adoption: `DayPlanNotifier`'s real port over the notification spine (`NotificationService`),
 * replacing the `LoggingDayPlanNotifier` stub as the DI default (`scheduling.module.ts`). Both
 * events have exactly one recipient — the SE themselves — so no extra recipient-resolution lookup
 * is needed here (contrast `SpineRecoveryNotifier.unableToCollect`, which resolves the zone's ZM).
 */
describe('#76 — SpineDayPlanNotifier (adoption)', () => {
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
    const u = await prisma.user.create({ data: { name: 'SE ' + t, role: 'SERVICE_ENGINEER', phone: 'dp-' + t, email: `dp-${t}@dp.test` } });
    userIds.push(u.userId);
    return u.userId;
  }

  it('dayPlanDispatched notifies the SE with the PRD:508 copy', async () => {
    const seId = await makeSe();
    const notifier = new SpineDayPlanNotifier(new NotificationService(prisma));

    await notifier.dayPlanDispatched({ seId, scheduleId: 1n, zoneId: 1n, stops: 2, tickets: 5 });

    const n = await prisma.notification.findFirstOrThrow({ where: { recipientUserId: seId, type: 'DAY_PLAN_DISPATCHED' } });
    notificationIds.push(n.id);
    expect(n.title).toBe('Your Day Plan is live');
    expect(n.body).toBe('Your Day Plan is live. Tap to start.');
    const inApp = await prisma.notificationDelivery.findFirst({ where: { notificationId: n.id, channel: 'IN_APP' } });
    expect(inApp?.status).toBe('SENT');
  });

  it('dayPlanOverridden notifies the SE naming the override action', async () => {
    const seId = await makeSe();
    const notifier = new SpineDayPlanNotifier(new NotificationService(prisma));

    await notifier.dayPlanOverridden({ seId, scheduleId: 1n, batchId: 2n, action: 'REMOVE_TICKET' });

    const n = await prisma.notification.findFirstOrThrow({ where: { recipientUserId: seId, type: 'DAY_PLAN_OVERRIDDEN' } });
    notificationIds.push(n.id);
    expect(n.body).toContain('REMOVE_TICKET');
  });
});
