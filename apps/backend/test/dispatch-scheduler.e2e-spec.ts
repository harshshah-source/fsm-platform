import { vi } from 'vitest';
import type { DispatchRunService } from '../src/scheduling/dispatch-run.service';
import {
  DEFAULT_DISPATCH_CRON,
  DispatchSchedulerService,
  readDispatchSchedulerConfig,
} from '../src/scheduling/dispatch-scheduler.service';

/**
 * Issue 113 — the daily dispatch tick. Same posture as the #108 BusinessSweepScheduler: gated by the
 * `BUSINESS_SWEEPS_ENABLED` master switch (default OFF), a single-in-flight guard, a structured
 * `SchedulerTickOutcome` that never throws out of cron, and one env-overridable cron
 * (`BUSINESS_SWEEP_DISPATCH_CRON`). The handler is driven directly here; the cron trigger is the
 * library's concern.
 */
const ran = (summary: Partial<{ zones: number; schedules: number; tickets: number; errors: unknown[] }> = {}) => ({
  result: 'RAN' as const,
  summary: { zones: 1, schedules: 1, tickets: 2, errors: [], runId: '1', ...summary },
});
const makeRun = () => ({ runForActiveZones: vi.fn(async () => ran()) });
const makeScheduler = (run: ReturnType<typeof makeRun>, enabled: boolean): DispatchSchedulerService =>
  new DispatchSchedulerService(run as unknown as DispatchRunService, { enabled });

describe('Issue 113 — DispatchSchedulerService', () => {
  it('readDispatchSchedulerConfig: OFF by default; cron defaults and env-overrides', () => {
    expect(readDispatchSchedulerConfig({})).toEqual({ enabled: false, dispatchCron: DEFAULT_DISPATCH_CRON });
    expect(readDispatchSchedulerConfig({ BUSINESS_SWEEPS_ENABLED: 'true' }).enabled).toBe(true);
    expect(readDispatchSchedulerConfig({ BUSINESS_SWEEPS_ENABLED: '1' }).enabled).toBe(false);
    expect(readDispatchSchedulerConfig({ BUSINESS_SWEEP_DISPATCH_CRON: '0 4 * * *' }).dispatchCron).toBe('0 4 * * *');
  });

  it('dispatches to runForActiveZones with the tick clock when enabled', async () => {
    const run = makeRun();
    const now = new Date('2026-07-08T05:00:00.000Z');
    const outcome = await makeScheduler(run, true).dispatchTick(now);

    expect(run.runForActiveZones).toHaveBeenCalledTimes(1);
    expect(run.runForActiveZones).toHaveBeenCalledWith(now);
    expect(outcome).toEqual({ ran: true });
  });

  it('is a dormant no-op when the master switch is off (default posture)', async () => {
    const run = makeRun();
    expect(await makeScheduler(run, false).dispatchTick()).toEqual({ ran: false, reason: 'DISABLED' });
    expect(run.runForActiveZones).not.toHaveBeenCalled();
  });

  it('a throwing run never escapes the cron context — reported as ERROR', async () => {
    const run = makeRun();
    run.runForActiveZones.mockRejectedValueOnce(new Error('boom') as never);
    expect(await makeScheduler(run, true).dispatchTick()).toEqual({ ran: false, reason: 'ERROR' });
  });

  /**
   * #213 — the in-flight guard is no longer this class's private field. It moved into
   * `runForActiveZones`, the one path this tick and the manual HTTP trigger share, because the private
   * field guarded only the cron while the manual trigger called straight past it. What is left to
   * assert here is that the tick *reports* a refusal it is handed rather than treating it as a run;
   * that the guard actually refuses a concurrent caller is proven end-to-end in
   * `dispatch-in-flight-guard.e2e-spec.ts`, against the real service with both entry points.
   */
  it('reports a refusal from the shared guard as RUN_IN_PROGRESS, not as a run', async () => {
    const run = makeRun();
    run.runForActiveZones.mockResolvedValueOnce({
      result: 'CONFLICT',
      inFlight: [{ zoneId: '1', startedAt: '2026-08-04T05:00:00.000Z', trigger: 'MANUAL', actor: 'OPERATIONS_HEAD' }],
    } as never);
    const scheduler = makeScheduler(run, true);

    expect(await scheduler.dispatchTick()).toEqual({ ran: false, reason: 'RUN_IN_PROGRESS' });
    // The next tick is not poisoned by the refusal — the guard is the run service's to release.
    expect(await scheduler.dispatchTick()).toEqual({ ran: true });
    expect(run.runForActiveZones).toHaveBeenCalledTimes(2);
  });

  it('registers the named business-dispatch cron under ScheduleModule (dormant, but on the clock)', async () => {
    const { Test } = await import('@nestjs/testing');
    const { ScheduleModule, SchedulerRegistry } = await import('@nestjs/schedule');

    const moduleRef = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      providers: [{ provide: DispatchSchedulerService, useFactory: () => makeScheduler(makeRun(), false) }],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    try {
      expect(app.get(SchedulerRegistry).getCronJobs().has('business-dispatch')).toBe(true);
    } finally {
      await app.close();
    }
  });

  /**
   * #204 / CONTEXT Decisions §19 — the dispatch run must fire at 05:00 **IST**, not 05:00 in
   * whatever timezone the host happens to have. Before this, `@Cron` carried no `timeZone` and no
   * `TZ` is set in any compose/Dockerfile/env in the repo, so on a UTC host the run landed at 10:30
   * IST — hours *into* the field day it is meant to precede.
   *
   * Asserted behaviourally (when does it actually next fire, in absolute terms) rather than by
   * reading the decorator's metadata, so it stays true regardless of how `@nestjs/schedule` stores
   * its options. 05:00 IST == 23:30 UTC the previous day.
   */
  it('#204: the business-dispatch cron fires at 05:00 IST regardless of host timezone', async () => {
    const { Test } = await import('@nestjs/testing');
    const { ScheduleModule, SchedulerRegistry } = await import('@nestjs/schedule');

    const moduleRef = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      providers: [{ provide: DispatchSchedulerService, useFactory: () => makeScheduler(makeRun(), false) }],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    try {
      const job = app.get(SchedulerRegistry).getCronJob('business-dispatch');
      const next = job.nextDate();
      // `cron` v3 returns a Luxon DateTime, v2 a Date — normalise to an absolute epoch either way.
      const nextUtc = new Date(typeof (next as { toJSDate?: unknown }).toJSDate === 'function'
        ? (next as unknown as { toJSDate: () => Date }).toJSDate()
        : (next as unknown as Date));
      expect(nextUtc.getUTCHours()).toBe(23);
      expect(nextUtc.getUTCMinutes()).toBe(30);
    } finally {
      await app.close();
    }
  });
});
