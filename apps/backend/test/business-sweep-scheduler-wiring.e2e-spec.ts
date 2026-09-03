import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { BusinessSweepSchedulerModule } from '../src/scheduling/business-sweep-scheduler.module';
import { BusinessSweepSchedulerService } from '../src/scheduling/business-sweep-scheduler.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { queueNotification } from '../src/scheduling/day-plan-notification-outbox';

/**
 * Issue 108 — wiring proof. Boots the REAL BusinessSweepSchedulerModule (pulling its full DI graph:
 * Verification / Intraday / CrossZone / Ticketing / Reports / Org) alongside ScheduleModule.forRoot().
 * This fails if any needed service is unexported, a constructor arg is misordered, or the module forms
 * a cycle — and confirms all eleven `@Cron` handlers (incl. Issue 157's tier-override-expiry sweep)
 * are discovered and registered at boot.
 */
describe('Issue 108 — BusinessSweepSchedulerModule boots and registers every cron', () => {
  it('resolves the scheduler from the real DI graph and registers all eleven named jobs', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot(), BusinessSweepSchedulerModule],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    try {
      expect(app.get(BusinessSweepSchedulerService)).toBeInstanceOf(BusinessSweepSchedulerService);
      const jobs = app.get(SchedulerRegistry).getCronJobs();
      for (const name of [
        'business-verification',
        'business-install-verification',
        'business-critical-assign',
        'business-cross-zone',
        'business-repeat-escalation',
        'business-tier-override-expiry',
        'business-soft-inactive',
        'business-system-efficiency',
        'business-fleet-uptime',
        'business-root-cause',
        'business-zm-performance',
      ]) {
        expect(jobs.has(name)).toBe(true);
      }
    } finally {
      await app.close();
    }
  });

  /**
   * #338 — the retry sweep must be able to deliver a GENERAL notice, not only day-plan events.
   *
   * The factory below `BusinessSweepSchedulerService`'s constructor stopped at `dayPlanNotifier`, so
   * the optional `notifications` deliverer was never supplied in the real container — every converted
   * producer's row would have been claimed, failed for want of a deliverer, un-claimed, and retried
   * to `MAX_OUTBOX_ATTEMPTS` before going quiet with a `last_error` nobody reads. The post-commit
   * drains hid it: they deliver on the happy path, so only a *failed* push would ever have reached
   * the sweep and discovered this.
   *
   * Asserted through the real DI graph and the real tick, because the defect was in the wiring — a
   * hand-built service would have passed while the app was broken. `firedAt` is a distinctive instant
   * so the tick-claim window is this test's alone.
   */
  it('#338 — the real container gives the outbox sweep a deliverer for general notices', async () => {
    const previous = process.env.BUSINESS_SWEEPS_ENABLED;
    process.env.BUSINESS_SWEEPS_ENABLED = 'true';
    const moduleRef = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot(), BusinessSweepSchedulerModule],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    const prisma = app.get(PrismaService);
    const firedAt = new Date('2031-01-05T03:04:00Z');
    const tag = 'ph-338w-' + Date.now();
    const se = await prisma.user.create({
      data: { name: 'SE outbox wiring', role: 'SERVICE_ENGINEER', phone: tag, email: `${tag}@wiring.test` },
    });
    const rowId = await queueNotification(prisma, {
      recipients: [{ userId: se.userId, role: 'SERVICE_ENGINEER' }],
      type: 'FIXTURE_338_WIRING',
      title: 'A general notice the sweep must be able to deliver',
    });
    try {
      const outcome = await app.get(BusinessSweepSchedulerService).notificationOutboxTick(firedAt);
      expect(outcome.ran).toBe(true);

      const row = await prisma.dayPlanNotificationOutbox.findUniqueOrThrow({ where: { id: rowId } });
      expect(row.lastError).toBeNull();
      expect(row.sentAt).not.toBeNull();
      expect(
        await prisma.notification.count({ where: { recipientUserId: se.userId, type: 'FIXTURE_338_WIRING' } }),
      ).toBe(1);
    } finally {
      await prisma.dayPlanNotificationOutbox.deleteMany({ where: { id: rowId } });
      await prisma.notificationDelivery.deleteMany({ where: { notification: { recipientUserId: se.userId } } });
      await prisma.notification.deleteMany({ where: { recipientUserId: se.userId } });
      await prisma.user.deleteMany({ where: { userId: se.userId } });
      await prisma.cronTickClaim.deleteMany({ where: { jobName: 'business-notification-outbox' } });
      await app.close();
      if (previous === undefined) delete process.env.BUSINESS_SWEEPS_ENABLED;
      else process.env.BUSINESS_SWEEPS_ENABLED = previous;
    }
  });
});
