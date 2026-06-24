import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * Issue 11, slice 6 — the SE Day Plan HTTP surface (AC#5). GET /api/schedules/me returns the
 * authenticated SE's Day Plan; before any dispatch it is the empty-state. Manager roles have no SE
 * Day Plan and are role-gated out. (The seeded SE has no dispatched schedule, so it exercises the
 * empty-state + auth contract; the populated payload is covered at the service level in slice 5.)
 */
describe('GET /api/schedules/me (e2e)', () => {
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

  it('returns the empty-state Day Plan for an SE with nothing dispatched', async () => {
    const token = await login('se.north@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/schedules/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.dispatched).toBe(false);
    expect(res.body.stops).toEqual([]);
  });

  it('forbids a non-SE role from the SE Day Plan endpoint', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .get('/api/schedules/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer()).get('/api/schedules/me').expect(401);
  });
});
