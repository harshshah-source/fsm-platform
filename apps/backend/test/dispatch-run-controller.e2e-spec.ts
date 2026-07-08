import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * Issue 113 AC#4 — the manual override. `POST /api/schedules/dispatch-run` lets Ops force a
 * Recommender → Day-Plan dispatch run without waiting for the daily cron, reusing the exact same
 * `DispatchRunService.runForActiveZones` code path. Role-guarded to Operations Head / CSM.
 */
describe('POST /api/schedules/dispatch-run (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  };

  it('lets Operations Head trigger a dispatch run and returns the run summary', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .post('/api/schedules/dispatch-run')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body).toMatchObject({
      zones: expect.any(Number),
      schedules: expect.any(Number),
      tickets: expect.any(Number),
      errors: expect.any(Array),
    });
  });

  it('forbids a Service Engineer from triggering a dispatch run', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/schedules/dispatch-run')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer()).post('/api/schedules/dispatch-run').expect(401);
  });
});
