import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { RecommenderService } from '../src/recommender/recommender.service';

/**
 * #213 slice 3 — the optional "why" on a manual dispatch run.
 *
 * Operator rationale, worth keeping verbatim: *"an emergency run with a one-line reason is worth a lot
 * when someone reads the audit trail three weeks later."* It stays **optional** — the trigger's existing
 * callers (including admin's zone-scoped Run-dispatch button) must keep working untouched — but when
 * supplied it is persisted on the `dispatch_runs` ledger row and surfaced in the run detail, not merely
 * logged and lost.
 *
 * The recommender is stubbed so these tests exercise the ledger, not the scoring engine.
 */
describe('#213 slice 3 — optional manual-run reason on the ledger (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RecommenderService)
      .useValue({
        runForZone: async () => ({
          ticketsConsidered: 0,
          recommended: 0,
          unassignable: 0,
          mode: 'DEFICIT',
          weightSetRef: 'test',
        }),
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  };

  const runNow = (token: string, body: Record<string, unknown>) =>
    request(app.getHttpServer()).post('/api/schedules/dispatch-run').set('Authorization', `Bearer ${token}`).send(body);

  it('persists a supplied reason on the ledger row and shows it in the run detail', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await runNow(token, { zoneId: 1, reason: 'master sync landed late, re-running before shift' }).expect(200);

    const row = await prisma.dispatchRun.findUniqueOrThrow({ where: { runId: BigInt(res.body.runId) } });
    expect(row.reason).toBe('master sync landed late, re-running before shift');
    expect(row.trigger).toBe('MANUAL');

    const detail = await request(app.getHttpServer())
      .get(`/api/dispatch-runs/${res.body.runId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(detail.body.reason).toBe('master sync landed late, re-running before shift');
  });

  it('stays optional — omitting it is still a valid run, with a null reason', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await runNow(token, { zoneId: 1 }).expect(200);

    const row = await prisma.dispatchRun.findUniqueOrThrow({ where: { runId: BigInt(res.body.runId) } });
    expect(row.reason).toBeNull();
  });

  it('trims whitespace and treats a blank reason as absent rather than storing an empty string', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await runNow(token, { zoneId: 1, reason: '   ' }).expect(200);

    const row = await prisma.dispatchRun.findUniqueOrThrow({ where: { runId: BigInt(res.body.runId) } });
    expect(row.reason).toBeNull();
  });

  it('a scheduled run has no reason — the field belongs to the manual trigger', async () => {
    const run = await prisma.dispatchRun.findFirst({ where: { trigger: 'CRON' }, orderBy: { runId: 'desc' } });
    if (run) expect(run.reason).toBeNull();
  });
});
