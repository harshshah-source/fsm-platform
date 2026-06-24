import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * Issue 14a, slice 2 — the SE Planner HTTP surface (AC#2/#5). Manager-roled CRUD at /api/planner;
 * SEs are gated out. (Zone-scoping behaviour is covered at the service level.)
 */
describe('SE Planner /api/planner (e2e)', () => {
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

  it('lists planner entries for a ZM', async () => {
    const token = await login('zm.north@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/planner?dateFrom=2026-06-22&dateTo=2026-06-28')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('forbids an SE from the planner', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .get('/api/planner?dateFrom=2026-06-22&dateTo=2026-06-28')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer()).get('/api/planner?dateFrom=2026-06-22&dateTo=2026-06-28').expect(401);
  });
});
