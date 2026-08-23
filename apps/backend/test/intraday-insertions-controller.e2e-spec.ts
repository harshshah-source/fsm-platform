import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * Issues 29/30, retired to direct-assignment by #268 — the `/api/intraday-insertions/*` HTTP surface
 * (RBAC + routing + input validation). The direct-assign/escalation behaviour itself is covered by the
 * `IntradayInsertionService` e2e spec. `accept`/`decline`/`sweep-timeouts` are retired with the offer
 * machinery they served and must 404 (#268 AC: "retired endpoints return 404").
 */
describe('/api/intraday-insertions (e2e)', () => {
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

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  }

  it('lets a ZM read the zone-scoped Intra-day Queue', async () => {
    const token = await login('zm.north@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/intraday-insertions')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('forbids an SE from reading the manager queue', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .get('/api/intraday-insertions')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('forbids an SE from triggering the manual sweep (manager-only)', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/intraday-insertions/fire')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('lets a ZM trigger the manual sweep for their own zone with no body', async () => {
    const token = await login('zm.north@fsm.test');
    const res = await request(app.getHttpServer())
      .post('/api/intraday-insertions/fire')
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(200);
    expect(res.body).toEqual({ assigned: expect.any(Number), escalated: expect.any(Number) });
  });

  it('404s the retired accept endpoint — the offer machinery it served is gone', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/intraday-insertions/999999999/accept')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('404s the retired decline endpoint', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/intraday-insertions/999999999/decline')
      .set('Authorization', `Bearer ${token}`)
      .send({ reasonCode: 'AT_CAPACITY' })
      .expect(404);
  });

  it('404s the retired sweep-timeouts endpoint', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/intraday-insertions/sweep-timeouts')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('404s the retired /me/intraday-insertions endpoint — the SE never had an offer to poll for', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .get('/api/me/intraday-insertions')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer()).get('/api/intraday-insertions').expect(401);
  });
});
