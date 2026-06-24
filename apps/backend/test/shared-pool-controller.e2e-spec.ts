import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * Issue 12, slice 5 — the Shared Pool HTTP surface (AC#4/#5). GET /api/me/shared-pool returns the
 * authenticated SE's covered-plant secondary work, scoped server-side to that SE's own id (never a
 * query param). SE-only, read-only (no Reject/pick mutation). The seeded SE has no DB coverage, so
 * this exercises the auth + role + empty contract.
 */
describe('GET /api/me/shared-pool (e2e)', () => {
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

  it('returns the SE shared pool (empty for an SE with no covered plants)', async () => {
    const token = await login('se.north@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/me/shared-pool')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toEqual([]);
  });

  it('forbids a non-SE role from the Shared Pool', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .get('/api/me/shared-pool')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer()).get('/api/me/shared-pool').expect(401);
  });
});
