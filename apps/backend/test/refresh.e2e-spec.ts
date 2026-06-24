import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Refresh-token rotation (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  async function login(): Promise<{ accessToken: string; refreshToken: string }> {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'zm.north@fsm.test', password: 'correct-password' })
      .expect(200);
    return res.body;
  }

  // TB8: rotation issues a fresh access token and a fresh (different) refresh token.
  it('issues a new access token and rotates the refresh token', async () => {
    const { refreshToken } = await login();

    const res = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .send({ refreshToken })
      .expect(200);

    expect(typeof res.body.accessToken).toBe('string');
    expect(typeof res.body.refreshToken).toBe('string');
    expect(res.body.refreshToken).not.toBe(refreshToken);
  });

  // TB8: a rotated (revoked) refresh token cannot be reused.
  it('rejects reuse of a rotated refresh token with 401', async () => {
    const { refreshToken } = await login();

    await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .send({ refreshToken })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .send({ refreshToken })
      .expect(401);
  });

  it('rejects an unknown refresh token with 401', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .send({ refreshToken: 'not-a-real-token' })
      .expect(401);
  });
});
