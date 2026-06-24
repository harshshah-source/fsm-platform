import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * TB9 — GET /api/settings returns the seeded system_settings registry (not the old `{}`
 * stub) to Operations Head. The app seeds defaults on boot; this proves the registry is
 * readable end-to-end through the guarded HTTP surface.
 */
describe('TB9 — GET /api/settings (e2e)', () => {
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

  it('returns the seeded settings registry to Operations Head', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/settings')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.inactivity_threshold_hours).toBe(24);
  });
});
