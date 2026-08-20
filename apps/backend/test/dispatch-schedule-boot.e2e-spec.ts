import type { INestApplication } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { DEFAULT_DISPATCH_CRON, DISPATCH_CRON_SETTING_KEY, DISPATCH_JOB_NAME } from '../src/scheduling/dispatch-cron';
import { DISPATCH_CRON_DESCRIPTION, DispatchScheduleService } from '../src/scheduling/dispatch-schedule.service';

/**
 * #257 — the boot half of #213, which had never once executed successfully.
 *
 * `DispatchScheduleService.onApplicationBootstrap` re-points the registered job at the stored
 * schedule — but Nest runs bootstrap hooks deepest-module-first (`b.distance - a.distance`), and on
 * this app's graph SchedulingModule's hook runs BEFORE `SchedulerOrchestrator`'s, which is the hook
 * that actually mounts `@Cron` jobs into the registry (`@nestjs/schedule@4.1.2`). So
 * `getCronJob('business-dispatch')` threw on every boot, the catch logged the
 * "could not be applied … No Cron Job was found" ERROR, and the job stayed on the compile-time
 * default. Invisible in production only because the seeded value EQUALS the default: the day an
 * operator changes the hour, the next restart silently reverts dispatch to 05:00 IST while the API
 * keeps reporting the stored value.
 *
 * The fix is `applyStoredSchedule()`, called from `main.ts` after `app.listen()` — the one point
 * where every module's bootstrap hook is guaranteed complete. These tests exercise exactly that
 * boot path: row written BEFORE the app exists, then init, then the main.ts step.
 *
 * The pre-existing "seeds the schedule on boot and registers the job at that time" test in
 * `dispatch-schedule-config.e2e-spec.ts` could not catch this: its stored value is the default, so
 * asserting the default's fire time passes whether the apply ran or not.
 */
describe('#257 — the stored dispatch schedule survives a restart', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const nextFireUtc = (): { hours: number; minutes: number } => {
    const job = app.get(SchedulerRegistry).getCronJob(DISPATCH_JOB_NAME);
    const next = job.nextDate() as unknown as { toJSDate?: () => Date };
    const d = typeof next.toJSDate === 'function' ? next.toJSDate() : (next as unknown as Date);
    return { hours: d.getUTCHours(), minutes: d.getUTCMinutes() };
  };

  beforeAll(async () => {
    // The operator's schedule exists BEFORE this process boots — the restart scenario. 06:00 IST is
    // 00:30 UTC; the compile-time default is 05:00 IST = 23:30 UTC, so the two are distinguishable.
    const seeder = new PrismaService();
    await seeder.onModuleInit();
    await seeder.systemSetting.upsert({
      where: { key: DISPATCH_CRON_SETTING_KEY },
      create: { key: DISPATCH_CRON_SETTING_KEY, value: '0 6 * * *', description: DISPATCH_CRON_DESCRIPTION },
      update: { value: '0 6 * * *' },
    });
    await seeder.onModuleDestroy();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    // Shared test DB (#255's lesson): put the row back on the default other specs assert against.
    prisma = app.get(PrismaService);
    await prisma.systemSetting.update({
      where: { key: DISPATCH_CRON_SETTING_KEY },
      data: { value: DEFAULT_DISPATCH_CRON as unknown as object },
    });
    await app.close();
  });

  it('the boot path (init + the main.ts apply step) brings the live job onto the stored schedule', async () => {
    await app.get(DispatchScheduleService).applyStoredSchedule();
    expect(nextFireUtc()).toEqual({ hours: 0, minutes: 30 }); // 06:00 IST — the stored value, not the default
  });

  it('a second apply is idempotent', async () => {
    await app.get(DispatchScheduleService).applyStoredSchedule();
    await app.get(DispatchScheduleService).applyStoredSchedule();
    expect(nextFireUtc()).toEqual({ hours: 0, minutes: 30 });
  });

  it('an unparseable stored expression leaves the previous schedule firing rather than taking the app down', async () => {
    const db = app.get(PrismaService);
    await db.systemSetting.update({
      where: { key: DISPATCH_CRON_SETTING_KEY },
      data: { value: 'not a cron' as unknown as object },
    });
    await app.get(DispatchScheduleService).applyStoredSchedule(); // must not throw
    expect(nextFireUtc()).toEqual({ hours: 0, minutes: 30 }); // still the last good schedule

    await db.systemSetting.update({
      where: { key: DISPATCH_CRON_SETTING_KEY },
      data: { value: '0 6 * * *' as unknown as object },
    });
  });
});
