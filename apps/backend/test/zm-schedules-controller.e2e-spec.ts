import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * Issue 13a slice 1 — ZM monitoring HTTP surface (AC#1/#2). GET /api/schedules (per-SE rows) and
 * GET /api/schedules/:engineerId (ordered stops + reasoning), manager-roled and zone-scoped. SEs read
 * their own plan via /api/schedules/me (Issue 11) and are gated out of the monitoring list.
 */
describe('ZM schedules monitoring (e2e)', () => {
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

  it('returns the per-SE schedule list for a ZM', async () => {
    const token = await login('zm.north@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/schedules')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('forbids an SE from the ZM monitoring list', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .get('/api/schedules')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('404s the detail for an engineer with no schedule in the ZM zone', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .get('/api/schedules/00000000-0000-0000-0000-0000000000ff')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer()).get('/api/schedules').expect(401);
  });

  it('404s critical-queue assign for an unknown ticket as a ZM', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/schedules/assign')
      .set('Authorization', `Bearer ${token}`)
      .send({ ticketId: '00000000-0000-0000-0000-0000000000ff', seId: '00000000-0000-0000-0000-0000000000ee' })
      .expect(404);
  });

  it('forbids an SE from the critical-queue assign', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/schedules/assign')
      .set('Authorization', `Bearer ${token}`)
      .send({ ticketId: '00000000-0000-0000-0000-0000000000ff', seId: '00000000-0000-0000-0000-0000000000ee' })
      .expect(403);
  });
});
