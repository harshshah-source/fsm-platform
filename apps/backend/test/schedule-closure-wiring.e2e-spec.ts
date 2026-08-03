import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { ScheduleClosureScheduler } from '../src/scheduling/schedule-closure-scheduler.service';
import { SchedulingModule } from '../src/scheduling/scheduling.module';

/**
 * Issue 147 slice 2 — wiring proof. A closer that is written but never registered leaves the defect
 * exactly where it was, and every behavioural test in `schedule-closure-scheduler.e2e-spec.ts`
 * constructs the service by hand, so none of them would notice. This boots the real SchedulingModule
 * and asserts both that the provider resolves and that its `@Cron` is discovered at boot.
 */
describe('Issue 147 — SchedulingModule registers the schedule-closure cron', () => {
  it('resolves ScheduleClosureScheduler and registers the named job', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot(), SchedulingModule],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    try {
      expect(app.get(ScheduleClosureScheduler)).toBeInstanceOf(ScheduleClosureScheduler);
      expect(app.get(SchedulerRegistry).getCronJobs().has('schedule-closure')).toBe(true);
    } finally {
      await app.close();
    }
  });
});
