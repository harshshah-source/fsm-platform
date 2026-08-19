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

  /**
   * #240 AC-1 — the closure tick must run *before* the dispatch tick it feeds, and that ordering is
   * only true if both crons are pinned to the same timezone. `@Cron` carried no `timeZone` here while
   * the dispatch cron (`dispatch-scheduler.service.ts:63`) did, and no `TZ` is set in any
   * compose/Dockerfile/env in this repo — so on a UTC host `0 4 * * *` fired at **09:30 IST**, 4.5 h
   * *after* the 05:00 IST dispatch, inverting the very ordering the service's docstring asserts.
   *
   * Asserted behaviourally — when does it actually next fire, in absolute terms — mirroring the #204
   * dispatch pin in `dispatch-scheduler.e2e-spec.ts`, so it stays true regardless of how
   * `@nestjs/schedule` stores its options. 04:00 IST == 22:30 UTC the previous day, one hour ahead of
   * the dispatch's 23:30 UTC.
   */
  it('#240: the schedule-closure cron fires at 04:00 IST, ahead of the 05:00 IST dispatch', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot(), SchedulingModule],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    try {
      const job = app.get(SchedulerRegistry).getCronJob('schedule-closure');
      const next = job.nextDate();
      // `cron` v3 returns a Luxon DateTime, v2 a Date — normalise to an absolute epoch either way.
      const nextUtc = new Date(
        typeof (next as { toJSDate?: unknown }).toJSDate === 'function'
          ? (next as unknown as { toJSDate: () => Date }).toJSDate()
          : (next as unknown as Date),
      );
      expect(nextUtc.getUTCHours()).toBe(22);
      expect(nextUtc.getUTCMinutes()).toBe(30);
    } finally {
      await app.close();
    }
  });
});
