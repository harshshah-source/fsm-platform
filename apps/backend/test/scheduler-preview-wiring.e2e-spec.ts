import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { SchedulerPreviewService } from '../src/scheduling/scheduler-preview.service';
import { SchedulesController } from '../src/scheduling/schedules.controller';

/**
 * #251 — wiring proof, written in response to an actual failure rather than in anticipation of one.
 *
 * `SchedulerPreviewService` was added to `SchedulingModule`'s **providers** but not its **exports**.
 * `SchedulesController` is registered in `AppModule`, so the service resolved fine when
 * `SchedulingModule` was booted alone and failed the moment the real app was assembled — taking 122
 * spec files down with it. Every one of them reported `Cannot read properties of undefined (reading
 * 'close')` from its own `afterAll`, because the boot failure left `app` unassigned: three hops from
 * the cause, and nothing in the message named the missing export.
 *
 * The specs that *did* pass were exactly the ones that could not catch it — `scheduler-preview.e2e`
 * constructs the service by hand, and `schedules-route-conflicts.e2e` stubs it. That is the same
 * gap `schedule-closure-wiring.e2e-spec.ts` was written to close for the closure cron, so this is
 * the same shape of test: boot the real module graph and assert the thing resolves.
 */
describe('#251 — AppModule resolves SchedulesController with the preview service', () => {
  it('boots the real app graph and injects SchedulerPreviewService into the controller', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    try {
      expect(app.get(SchedulesController)).toBeInstanceOf(SchedulesController);
      // Resolved from the AppModule context specifically — the export that was missing.
      expect(app.get(SchedulerPreviewService)).toBeInstanceOf(SchedulerPreviewService);
    } finally {
      await app.close();
    }
  });
});
