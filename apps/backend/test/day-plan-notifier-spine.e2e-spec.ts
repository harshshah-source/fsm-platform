import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { NotificationService } from '../src/notifications/notification.service';
import { dayPlanOverriddenBody, SpineDayPlanNotifier } from '../src/scheduling/day-plan-notifier';
import { DAY_PLAN_ACTION_PLANT_DEACTIVATED } from '../src/scheduling/day-plan-notification-outbox';

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

  /**
   * #360 AC3 — this assertion used to be `expect(n.body).toContain('REMOVE_TICKET')`, which is
   * exactly the defect: the SE's phone showed them a raw audit-action enum. The notice now names the
   * stop, and the enum never reaches the wire.
   */
  it('#360 — dayPlanOverridden notifies the SE with a readable sentence naming the stop, not the enum', async () => {
    const seId = await makeSe();
    const notifier = new SpineDayPlanNotifier(new NotificationService(prisma));

    await notifier.dayPlanOverridden({
      seId,
      scheduleId: 1n,
      batchId: 2n,
      action: 'REMOVE_TICKET',
      plantName: 'Ambuja Sanand',
      ticketNoDisplay: 'TCK-00123',
    });

    const n = await prisma.notification.findFirstOrThrow({ where: { recipientUserId: seId, type: 'DAY_PLAN_OVERRIDDEN' } });
    notificationIds.push(n.id);
    expect(n.body).toContain('Ambuja Sanand');
    expect(n.body).toContain('TCK-00123');
    expect(n.body).not.toContain('REMOVE_TICKET');
    // The action is still recorded in metadata — the operator's audit trail is not the SE's sentence.
    expect((n.metadata as { action?: string } | null)?.action).toBe('REMOVE_TICKET');
  });

  describe('#360 AC3 — dayPlanOverriddenBody: the closed set of sentences an SE can be sent', () => {
    /** Every action that reaches `queueDayPlanOverridden` from a producer today. */
    const ACTIONS = [
      'REMOVE_TICKET',
      'DEFER_TICKET',
      'REORDER',
      'SWAP_SE',
      'REASSIGN',
      'SPLIT_BATCH',
      'MOVE_TICKET',
      'CRITICAL_ASSIGN',
      'MANUAL_ZM_UPDATE',
      'ASSIGN_BATCH_COMMIT',
      DAY_PLAN_ACTION_PLANT_DEACTIVATED,
    ];

    /** A SCREAMING_SNAKE token — what an enum looks like when it leaks into prose. `TCK-00123` and
     *  ordinary words do not match; `REMOVE_TICKET` does. */
    const ENUM_SHAPED = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;

    it.each(ACTIONS)('%s reads as a sentence with no enum in it', (action) => {
      const named = dayPlanOverriddenBody({
        seId: 'se', scheduleId: 1n, batchId: 2n, action,
        plantName: 'Ambuja Sanand', ticketNoDisplay: 'TCK-00123',
      });
      const bare = dayPlanOverriddenBody({ seId: 'se', scheduleId: 1n, batchId: 2n, action });

      for (const body of [named, bare]) {
        expect(body).not.toMatch(ENUM_SHAPED);
        expect(body).not.toContain('undefined');
        expect(body).not.toContain('null');
        expect(body.length).toBeGreaterThan(10);
      }
      // A named stop is actually named — the whole point of widening the payload.
      expect(named).toContain('Ambuja Sanand');
    });

    it('an unknown action still produces a usable sentence rather than leaking itself', () => {
      const body = dayPlanOverriddenBody({ seId: 'se', scheduleId: 1n, batchId: 2n, action: 'SOME_NEW_ACTION' });
      expect(body).not.toContain('SOME_NEW_ACTION');
      expect(body).toContain('Day Plan');
    });

    it('#345 stays true — a deactivation names the plant and says the stop is gone', () => {
      const body = dayPlanOverriddenBody({
        seId: 'se', scheduleId: 1n, batchId: 2n,
        action: DAY_PLAN_ACTION_PLANT_DEACTIVATED, plantName: 'Ambuja Sanand',
      });
      expect(body).toContain('Ambuja Sanand');
      expect(body).toContain('deactivated');
    });
  });
});
