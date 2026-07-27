import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { BusinessSweepSchedulerModule } from '../src/scheduling/business-sweep-scheduler.module';
import { BusinessSweepSchedulerService } from '../src/scheduling/business-sweep-scheduler.service';

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
        'business-intraday-timeout',
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
});
