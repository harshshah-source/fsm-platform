import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { NotificationService } from '../src/notifications/notification.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { drainRows, queueNotification } from '../src/scheduling/day-plan-notification-outbox';
import { SHARED_AUTH_SE_ID } from './fixtures/shared-auth-se';

/**
 * #338 — the outbox carries general notifications, not only day-plan events.
 *
 * Twelve `notify()` sites fire *after* their transaction commits with no durable row behind them, so
 * a crash between commit and delivery loses the notice silently. #264 built the durable path and
 * scoped it to the two day-plan events; this generalises the same table rather than adding a second
 * one, because a second table would mean a second drain, a second retry policy and a second thing to
 * remember to prune.
 *
 * `NotifyInput` is already a plain serialisable object, which is what makes this cheap: the row
 * stores the *resolved* input and the drain replays `notify()`. Resolving recipients inside the
 * producing transaction (cross-zone resolves them by role) also makes the row say who it was for,
 * instead of re-deriving an answer that may have changed by the time the sweep runs.
 *
 * These rows are committed, not rolled back — a drain in a different transaction cannot see an
 * uncommitted row, which is the whole property under test. Every row this file writes is deleted in
 * `afterEach`, since the suite shares one never-truncated database (#156).
 */
describe('#338 generic notification outbox (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let notifications: NotificationService;

  const written: bigint[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
    notifications = app.get(NotificationService);
  });

  afterEach(async () => {
    if (written.length > 0) {
      await prisma.dayPlanNotificationOutbox.deleteMany({ where: { id: { in: written } } });
      written.length = 0;
    }
    await prisma.notification.deleteMany({ where: { type: { startsWith: 'FIXTURE_338_' } } });
  });

  afterAll(async () => {
    await app.close();
  });

  it('writes a notice with no schedule and no engineer, and delivers it on drain', async () => {
    const input = {
      recipients: [{ userId: SHARED_AUTH_SE_ID, role: 'SERVICE_ENGINEER' as const }],
      type: 'FIXTURE_338_GENERIC',
      title: 'A notice that belongs to no day plan',
      body: 'Enqueued inside a transaction, delivered by the drain.',
    };

    // Enqueued through the same client a producer would use inside its own mutation transaction.
    const id = await queueNotification(prisma, input);
    written.push(id);

    const queued = await prisma.dayPlanNotificationOutbox.findUniqueOrThrow({ where: { id } });
    // The two day-plan-shaped columns are exactly what a general notice does not have. Before this
    // slice they were NOT NULL, which is why the table could only ever hold day-plan events.
    expect(queued.seId).toBeNull();
    expect(queued.scheduleId).toBeNull();
    expect(queued.sentAt).toBeNull();

    const before = await prisma.notification.count({ where: { type: 'FIXTURE_338_GENERIC' } });
    expect(before).toBe(0);

    await drainRows(prisma, { dayPlanDispatched: async () => {}, dayPlanOverridden: async () => {} }, [id], new Date(), notifications);

    const after = await prisma.notification.findMany({ where: { type: 'FIXTURE_338_GENERIC' } });
    expect(after).toHaveLength(1);
    expect(after[0]!.recipientUserId).toBe(SHARED_AUTH_SE_ID);

    const drained = await prisma.dayPlanNotificationOutbox.findUniqueOrThrow({ where: { id } });
    expect(drained.sentAt).not.toBeNull();
    expect(drained.attempts).toBe(1);
  });

  it('leaves the row for a later drain when no notify deliverer is supplied', async () => {
    const id = await queueNotification(prisma, {
      recipients: [{ userId: SHARED_AUTH_SE_ID, role: 'SERVICE_ENGINEER' as const }],
      type: 'FIXTURE_338_NO_DELIVERER',
      title: 'Nobody to hand this to yet',
    });
    written.push(id);

    // The post-commit drains in `override.service` and `batch-assignment` pass no notify deliverer —
    // they exist to flush the day-plan rows they just wrote. A generic row must NOT be silently
    // marked sent by one of them: the claim happens before delivery, so a quiet skip would burn the
    // row. It has to fail and be un-claimed, so the sweep (which does have the deliverer) retries it.
    await drainRows(prisma, { dayPlanDispatched: async () => {}, dayPlanOverridden: async () => {} }, [id], new Date());

    const row = await prisma.dayPlanNotificationOutbox.findUniqueOrThrow({ where: { id } });
    expect(row.sentAt).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.lastError).toMatch(/deliverer/i);
    expect(await prisma.notification.count({ where: { type: 'FIXTURE_338_NO_DELIVERER' } })).toBe(0);
  });
});
