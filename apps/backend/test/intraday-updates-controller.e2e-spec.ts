import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * Issue 31 slice 3 — the ZM manual same-day update HTTP surface (`/api/intraday-updates`). Manager-
 * roled; an SE is gated out of the queue read and the actions; bad input is 400. The same-day
 * behaviours themselves (ADD / REMOVE+conflict / REORDER + intra-day logging) are covered by the
 * SameDayUpdateService e2e specs.
 */
describe('/api/intraday-updates (e2e)', () => {
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

  it('returns the zone-scoped Intra-day Queue for a manager (200, array)', async () => {
    const token = await login('zm.north@fsm.test');
    const res = await request(app.getHttpServer()).get('/api/intraday-updates').set('Authorization', `Bearer ${token}`).expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('forbids an SE from the queue read and the actions (403)', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer()).get('/api/intraday-updates').set('Authorization', `Bearer ${token}`).expect(403);
    await request(app.getHttpServer())
      .post('/api/intraday-updates/add')
      .set('Authorization', `Bearer ${token}`)
      .send({ ticketId: '00000000-0000-0000-0000-0000000000aa', seId: '00000000-0000-0000-0000-0000000000bb' })
      .expect(403);
  });

  it('rejects an unauthenticated read (401)', async () => {
    await request(app.getHttpServer()).get('/api/intraday-updates').expect(401);
  });

  it('400s a remove with no reason code, 404s an add for an unknown ticket', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/intraday-updates/remove')
      .set('Authorization', `Bearer ${token}`)
      .send({ batchId: '1', ticketId: '00000000-0000-0000-0000-0000000000aa' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/intraday-updates/add')
      .set('Authorization', `Bearer ${token}`)
      .send({ ticketId: '00000000-0000-0000-0000-0000000000aa', seId: '00000000-0000-0000-0000-0000000000bb' })
      .expect(404);
  });
});
