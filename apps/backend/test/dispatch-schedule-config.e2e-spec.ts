import type { INestApplication } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  DEFAULT_DISPATCH_CRON,
  DISPATCH_CRON_SETTING_KEY,
  DISPATCH_JOB_NAME,
  bootstrapDispatchCron,
} from '../src/scheduling/dispatch-cron';

/**
 * #213 slice 1 — the daily dispatch time becomes operator-configurable, with `system_settings` as the
 * source of truth and `BUSINESS_SWEEP_DISPATCH_CRON` demoted to a bootstrap default consulted only when
 * no setting row exists.
 *
 * The two properties that matter more than the plumbing (operator ruling, recorded on #213):
 *  1. a change takes effect **without a restart** — the job is re-registered on write, so these tests
 *     assert the *live* job's next fire moves inside one process;
 *  2. an invalid expression is **rejected at write time** and the previous schedule is left intact and
 *     still firing — never accepted-then-silently-dead, because a schedule that is quietly dead
 *     surfaces only when someone notices there is no day plan.
 */
const nextFireUtc = (app: INestApplication): { hours: number; minutes: number } => {
  const job = app.get(SchedulerRegistry).getCronJob(DISPATCH_JOB_NAME);
  const next = job.nextDate() as unknown as { toJSDate?: () => Date };
  // `cron` v3 returns a Luxon DateTime, v2 a Date — normalise to an absolute epoch either way.
  const d = typeof next.toJSDate === 'function' ? next.toJSDate() : (next as unknown as Date);
  return { hours: d.getUTCHours(), minutes: d.getUTCMinutes() };
};

describe('#213 slice 1 — operator-configurable dispatch schedule (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    // Shared test DB: leave the registry on its default so specs that boot AppModule after this one
    // see the canonical 05:00 IST schedule.
    await prisma.systemSetting.update({
      where: { key: DISPATCH_CRON_SETTING_KEY },
      data: { value: DEFAULT_DISPATCH_CRON as unknown as object },
    });
    await app.close();
  });

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  };

  const put = (token: string, cron: unknown) =>
    request(app.getHttpServer()).put('/api/schedules/dispatch-schedule').set('Authorization', `Bearer ${token}`).send({ cron });

  it('bootstrapDispatchCron: the env var is the bootstrap default, falling back to 05:00 IST', () => {
    expect(bootstrapDispatchCron({})).toBe(DEFAULT_DISPATCH_CRON);
    expect(bootstrapDispatchCron({ BUSINESS_SWEEP_DISPATCH_CRON: '0 4 * * *' })).toBe('0 4 * * *');
    expect(bootstrapDispatchCron({ BUSINESS_SWEEP_DISPATCH_CRON: '   ' })).toBe(DEFAULT_DISPATCH_CRON);
  });

  it('seeds the schedule into system_settings on boot and registers the job at that time', async () => {
    const row = await prisma.systemSetting.findUnique({ where: { key: DISPATCH_CRON_SETTING_KEY } });
    expect(row?.value).toBe(DEFAULT_DISPATCH_CRON);
    expect(nextFireUtc(app)).toEqual({ hours: 23, minutes: 30 }); // 05:00 IST
  });

  it('GET returns the current schedule, its timezone and the next fire', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/schedules/dispatch-schedule')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.cron).toBe(DEFAULT_DISPATCH_CRON);
    expect(res.body.timeZone).toBe('Asia/Kolkata');
    expect(typeof res.body.nextFireAt).toBe('string');
  });

  it('THE POINT OF THIS ISSUE: an OH write takes effect with no restart — the live job re-fires at the new time', async () => {
    const token = await login('ops.head@fsm.test');
    await put(token, '0 6 * * *').expect(200);

    // Same process, same registry, no re-init: 06:00 IST == 00:30 UTC.
    expect(nextFireUtc(app)).toEqual({ hours: 0, minutes: 30 });
    const row = await prisma.systemSetting.findUnique({ where: { key: DISPATCH_CRON_SETTING_KEY } });
    expect(row?.value).toBe('0 6 * * *');
  });

  it('logs the change with the actor, the previous value and the new value', async () => {
    const token = await login('ops.head@fsm.test');
    await put(token, '30 5 * * *').expect(200);

    const log = await prisma.auditLog.findFirst({
      where: { action: 'DISPATCH_SCHEDULE_UPDATED' },
      orderBy: { createdAt: 'desc' },
    });
    expect(log).not.toBeNull();
    expect(log?.actorRole).toBe('OPERATIONS_HEAD');
    expect(log?.metadata).toMatchObject({ previous: '0 6 * * *', next: '30 5 * * *' });
  });

  it('rejects an invalid expression at write time and leaves the previous schedule intact AND still firing', async () => {
    const token = await login('ops.head@fsm.test');
    const before = nextFireUtc(app); // 05:30 IST == 00:00 UTC, from the previous test

    for (const bad of ['not a cron', '99 99 * * *', '', '   ', null, 42]) {
      const res = await put(token, bad).expect(400);
      expect(res.body.code).toBe('INVALID_CRON_EXPRESSION');
    }

    expect(nextFireUtc(app)).toEqual(before);
    const row = await prisma.systemSetting.findUnique({ where: { key: DISPATCH_CRON_SETTING_KEY } });
    expect(row?.value).toBe('30 5 * * *');
  });

  it('is Operations-Head-only — CSM, ZM and SE cannot change it, and unauth is 401', async () => {
    for (const email of ['csm@fsm.test', 'zm.north@fsm.test', 'se.north@fsm.test']) {
      const token = await login(email);
      await put(token, '0 7 * * *').expect(403);
    }
    await request(app.getHttpServer()).put('/api/schedules/dispatch-schedule').send({ cron: '0 7 * * *' }).expect(401);
    const row = await prisma.systemSetting.findUnique({ where: { key: DISPATCH_CRON_SETTING_KEY } });
    expect(row?.value).toBe('30 5 * * *');
  });

  /**
   * The generic settings registry can write any key (`PUT /api/settings/:key`, OH-only). Left open, it
   * is a hole straight past both guarantees above: an unvalidated value would be accepted and the job
   * would never be re-registered — the schedule would read as changed and keep firing at the old time.
   */
  it('refuses to let the generic settings endpoint write the schedule behind the scheduler back', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .put(`/api/settings/${DISPATCH_CRON_SETTING_KEY}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ value: '0 9 * * *' })
      .expect(400);
    expect(res.body.code).toBe('USE_DISPATCH_SCHEDULE_ENDPOINT');

    const row = await prisma.systemSetting.findUnique({ where: { key: DISPATCH_CRON_SETTING_KEY } });
    expect(row?.value).toBe('30 5 * * *');
  });

  it("records the configured schedule in a run's config snapshot, not the env var", async () => {
    const token = await login('ops.head@fsm.test');
    await request(app.getHttpServer())
      .post('/api/schedules/dispatch-run')
      .set('Authorization', `Bearer ${token}`)
      .send({ zoneId: 1 })
      .expect(200);

    const run = await prisma.dispatchRun.findFirst({ orderBy: { runId: 'desc' } });
    const snapshot = run?.configSnapshot as { scheduler?: { dispatchCron?: string } } | null;
    expect(snapshot?.scheduler?.dispatchCron).toBe('30 5 * * *');
  });
});
