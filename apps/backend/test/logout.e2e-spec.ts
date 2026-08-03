import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * Issue #91 S3 — `POST /api/auth/logout`. Previously there was no logout/revocation endpoint at all
 * (2026-07-28 comment): a lost/stolen handset's refresh token stayed valid server-side for up to 30
 * days no matter what the client did locally. This closes that gap.
 */
describe('Logout (#91 S3)', () => {
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

  async function login(): Promise<{ accessToken: string; refreshToken: string }> {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'csm@fsm.test', password: 'correct-password' })
      .expect(200);
    return res.body;
  }

  it('revokes the presented refresh token; a subsequent refresh attempt is rejected with 401', async () => {
    const { refreshToken } = await login();

    await request(app.getHttpServer())
      .post('/api/auth/logout')
      .send({ refreshToken })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .send({ refreshToken })
      .expect(401);
  });

  it('is tokenless (no Authorization header required) — the refresh token IS the credential', async () => {
    const { refreshToken } = await login();
    await request(app.getHttpServer())
      .post('/api/auth/logout')
      .send({ refreshToken })
      // deliberately no .set('Authorization', ...)
      .expect(200);
  });

  // Logout must not become an oracle for whether a refresh token was ever valid — no distinct status
  // for "unknown token" vs "already-revoked token" vs "never existed".
  it('returns 200 for an unknown/garbage refresh token (no token-validity oracle)', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/logout')
      .send({ refreshToken: 'not-a-real-token' })
      .expect(200);
  });

  it('is idempotent — logging out twice with the same token both return 200', async () => {
    const { refreshToken } = await login();
    await request(app.getHttpServer()).post('/api/auth/logout').send({ refreshToken }).expect(200);
    await request(app.getHttpServer()).post('/api/auth/logout').send({ refreshToken }).expect(200);
  });
});
