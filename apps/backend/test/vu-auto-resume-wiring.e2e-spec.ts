import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { TicketingModule } from '../src/ticketing/ticketing.module';
import {
  DEFAULT_VU_AUTO_RESUME_CRON,
  VehicleReturnResumeScheduler,
  readVehicleReturnResumeConfig,
} from '../src/ticketing/vehicle-return-resume-scheduler.service';

/**
 * #247 AC4 — wiring proof, and the cron ordering the acceptance criterion is actually about.
 *
 * A sweep that is written but never registered leaves the defect exactly where it was, and every
 * behavioural test in `vu-auto-resume-sweep.e2e-spec.ts` constructs the service by hand, so none of
 * them would notice. `schedule-closure-wiring.e2e-spec.ts` is the precedent this follows, including
 * its #240 lesson: the ordering claim is only true if the cron is pinned to the business timezone.
 * `@Cron` with no `timeZone` fires in the host process timezone, and no `TZ` is set in any
 * compose/Dockerfile/env in this repo — so on a UTC host an unpinned `30 3 * * *` would fire at 09:00
 * IST, four hours *after* the dispatch run it is supposed to precede, and the ticket would be selected
 * with its clock still frozen. Asserted behaviourally (when does it next fire, absolutely) rather than
 * by reading back the stored options.
 */
describe('#247 — TicketingModule registers the vehicle-return auto-resume cron', () => {
  const nextUtc = (job: { nextDate(): unknown }): Date => {
    const next = job.nextDate();
    // `cron` v3 returns a Luxon DateTime, v2 a Date — normalise to an absolute epoch either way.
    return new Date(
      typeof (next as { toJSDate?: unknown }).toJSDate === 'function'
        ? (next as { toJSDate: () => Date }).toJSDate()
        : (next as Date),
    );
  };

  it('resolves VehicleReturnResumeScheduler and registers the named job', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot(), TicketingModule],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    try {
      expect(app.get(VehicleReturnResumeScheduler)).toBeInstanceOf(VehicleReturnResumeScheduler);
      expect(app.get(SchedulerRegistry).getCronJobs().has('vu-auto-resume')).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('AC4 — the auto-resume cron fires at 03:30 IST, ahead of the 05:00 IST dispatch', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot(), TicketingModule],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    try {
      const fires = nextUtc(app.get(SchedulerRegistry).getCronJob('vu-auto-resume'));
      // 03:30 IST == 22:00 UTC the previous day; the dispatch's 05:00 IST is 23:30 UTC.
      expect(fires.getUTCHours()).toBe(22);
      expect(fires.getUTCMinutes()).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('AC4 — the tick is dormant unless the BUSINESS_SWEEPS_ENABLED master switch is on', () => {
    expect(readVehicleReturnResumeConfig({} as NodeJS.ProcessEnv).enabled).toBe(false);
    expect(readVehicleReturnResumeConfig({ BUSINESS_SWEEPS_ENABLED: 'false' } as NodeJS.ProcessEnv).enabled).toBe(false);
    expect(readVehicleReturnResumeConfig({ BUSINESS_SWEEPS_ENABLED: 'true' } as NodeJS.ProcessEnv).enabled).toBe(true);
    // The cadence is operator-overridable, like every other sweep's.
    expect(readVehicleReturnResumeConfig({} as NodeJS.ProcessEnv).resumeCron).toBe(DEFAULT_VU_AUTO_RESUME_CRON);
    expect(readVehicleReturnResumeConfig({ VU_AUTO_RESUME_CRON: '15 2 * * *' } as NodeJS.ProcessEnv).resumeCron).toBe('15 2 * * *');
  });

  it('AC4 — a disabled tick runs nothing, and an overlapping tick is a logged skip, never a throw', async () => {
    let calls = 0;
    let release: (() => void) | null = null;
    const sweep = {
      sweepReturnedVehicles: () =>
        new Promise<{ resumed: number }>((resolve) => {
          calls += 1;
          release = () => resolve({ resumed: 0 });
        }),
    };

    const off = new VehicleReturnResumeScheduler(sweep as never, { enabled: false });
    expect(await off.resumeTick()).toEqual({ ran: false, reason: 'DISABLED' });
    expect(calls).toBe(0);

    const on = new VehicleReturnResumeScheduler(sweep as never, { enabled: true });
    const first = on.resumeTick();
    const second = await on.resumeTick();
    expect(second).toEqual({ ran: false, reason: 'RUN_IN_PROGRESS' });
    release!();
    expect(await first).toEqual({ ran: true });
    expect(calls).toBe(1);

    // A sweep that throws is an ERROR outcome, not an unhandled rejection out of the cron context.
    const boom = new VehicleReturnResumeScheduler(
      { sweepReturnedVehicles: () => Promise.reject(new Error('boom')) } as never,
      { enabled: true },
    );
    expect(await boom.resumeTick()).toEqual({ ran: false, reason: 'ERROR' });
  });
});
