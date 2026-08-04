import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { DAY_PLAN_NOTIFIER, SpineDayPlanNotifier } from '../src/scheduling/day-plan-notifier';
import { INSTALL_NOTIFIER, SpineInstallNotifier } from '../src/ticketing/install-notifier';
import { RECOVERY_NOTIFIER, SpineRecoveryNotifier } from '../src/ticketing/recovery-notifier';

/**
 * #76 adoption — proves the real app boots with the Spine*Notifier classes as the DI default for
 * each token, not just that the classes work in isolation (the `*-notifier-spine.e2e-spec.ts`
 * files prove the mapping logic; this proves the module wiring that puts them in the request path).
 */
describe('#76 — notifier adoption DI wiring', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('DAY_PLAN_NOTIFIER resolves to SpineDayPlanNotifier', () => {
    expect(app.get(DAY_PLAN_NOTIFIER)).toBeInstanceOf(SpineDayPlanNotifier);
  });

  it('RECOVERY_NOTIFIER resolves to SpineRecoveryNotifier', () => {
    expect(app.get(RECOVERY_NOTIFIER)).toBeInstanceOf(SpineRecoveryNotifier);
  });

  it('INSTALL_NOTIFIER resolves to SpineInstallNotifier', () => {
    expect(app.get(INSTALL_NOTIFIER)).toBeInstanceOf(SpineInstallNotifier);
  });
});
