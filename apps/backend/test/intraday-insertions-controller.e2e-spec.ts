import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * Issues 29/30 — the `/api/intraday-insertions/*` HTTP surface (RBAC + routing + input validation). The
 * accept/decline/reroute behaviours themselves are covered by the IntradayInsertionService e2e spec.
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

  it('forbids a manager from accepting (SE-only action)', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/intraday-insertions/999999999/accept')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('404s an SE accept on an unknown insertion', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/intraday-insertions/999999999/accept')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('400s a decline with a missing reason code', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/intraday-insertions/999999999/decline')
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(400);
  });

  it('400s a decline with an invalid reason code', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/intraday-insertions/999999999/decline')
      .set('Authorization', `Bearer ${token}`)
      .send({ reasonCode: 'NOT_A_CODE' })
      .expect(400);
  });

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer()).get('/api/intraday-insertions').expect(401);
  });
});
