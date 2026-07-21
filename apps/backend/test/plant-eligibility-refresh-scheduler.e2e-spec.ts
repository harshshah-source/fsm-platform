import { vi } from 'vitest';
import type { PlantEligibleFloatingSeService } from '../src/org/plant-eligible-floating-se.service';
import {
  DEFAULT_PLANT_ELIGIBILITY_REFRESH_CRON,
  PlantEligibilityRefreshScheduler,
  readPlantEligibilityRefreshConfig,
} from '../src/org/plant-eligibility-refresh-scheduler.service';

/**
 * Issue 138 slice 3 — a periodic backstop that keeps `plant_eligible_floating_se` fresh independently of
 * territory edits (which refresh on-write) and master-sync (slice 2). Same posture as
 * DispatchSchedulerService: gated by `BUSINESS_SWEEPS_ENABLED` (default OFF — the same gate as the
 * dispatch this feeds), a single-in-flight guard, and a tick that NEVER throws out of the cron context.
 * Env-overridable cron (`PLANT_ELIGIBILITY_REFRESH_CRON`). Seam: the tick + the config reader.
 */
const makeSvc = () => ({ refresh: vi.fn(async () => undefined) });
const makeScheduler = (svc: ReturnType<typeof makeSvc>, enabled: boolean): PlantEligibilityRefreshScheduler =>
  new PlantEligibilityRefreshScheduler(svc as unknown as PlantEligibleFloatingSeService, { enabled });

describe('Issue 138 slice 3 — PlantEligibilityRefreshScheduler', () => {
  it('readPlantEligibilityRefreshConfig: OFF by default; cron default + env override; enabled only on "true"', () => {
    expect(readPlantEligibilityRefreshConfig({})).toEqual({
      enabled: false,
      refreshCron: DEFAULT_PLANT_ELIGIBILITY_REFRESH_CRON,
    });
    expect(readPlantEligibilityRefreshConfig({ BUSINESS_SWEEPS_ENABLED: 'true' }).enabled).toBe(true);
    expect(readPlantEligibilityRefreshConfig({ BUSINESS_SWEEPS_ENABLED: '1' }).enabled).toBe(false);
    expect(readPlantEligibilityRefreshConfig({ PLANT_ELIGIBILITY_REFRESH_CRON: '0 3 * * *' }).refreshCron).toBe('0 3 * * *');
  });

  it('refreshes the MV when enabled', async () => {
    const svc = makeSvc();
    const outcome = await makeScheduler(svc, true).refreshTick();
    expect(svc.refresh).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ ran: true });
  });

  it('is a dormant no-op when the master switch is off (default posture)', async () => {
    const svc = makeSvc();
    expect(await makeScheduler(svc, false).refreshTick()).toEqual({ ran: false, reason: 'DISABLED' });
    expect(svc.refresh).not.toHaveBeenCalled();
  });

  it('a throwing refresh never escapes the cron context — reported as ERROR', async () => {
    const svc = makeSvc();
    svc.refresh.mockRejectedValueOnce(new Error('boom') as never);
    expect(await makeScheduler(svc, true).refreshTick()).toEqual({ ran: false, reason: 'ERROR' });
  });

  it('single-in-flight guard: an overlapping tick skips with RUN_IN_PROGRESS', async () => {
    const svc = makeSvc();
    let release!: () => void;
    svc.refresh.mockImplementationOnce(() => new Promise((res) => { release = () => res(undefined as never); }));
    const scheduler = makeScheduler(svc, true);

    const first = scheduler.refreshTick();
    const second = await scheduler.refreshTick();
    expect(second).toEqual({ ran: false, reason: 'RUN_IN_PROGRESS' });
    expect(svc.refresh).toHaveBeenCalledTimes(1);

    release();
    expect(await first).toEqual({ ran: true });
    expect(await scheduler.refreshTick()).toEqual({ ran: true });
    expect(svc.refresh).toHaveBeenCalledTimes(2);
  });

  it('registers the named plant-eligibility-refresh cron under ScheduleModule (dormant, on the clock)', async () => {
    const { Test } = await import('@nestjs/testing');
    const { ScheduleModule, SchedulerRegistry } = await import('@nestjs/schedule');

    const moduleRef = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      providers: [{ provide: PlantEligibilityRefreshScheduler, useFactory: () => makeScheduler(makeSvc(), false) }],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    try {
      expect(app.get(SchedulerRegistry).getCronJobs().has('plant-eligibility-refresh')).toBe(true);
    } finally {
      await app.close();
    }
  });
});
