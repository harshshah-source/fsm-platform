import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('GET /api/me (e2e)', () => {
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

  async function login(): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'zm.north@fsm.test', password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  }

  // TB3: a verified token's claims (role + zone) are returned to the caller.
  it('returns the authenticated caller\'s user_id, role and zone', async () => {
    const token = await login();

    const res = await request(app.getHttpServer())
      .get('/api/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body).toEqual({
      user_id: '11111111-1111-1111-1111-111111111111',
      role: 'ZONAL_MANAGER',
      zone_id: 1,
      acted_as_role: null,
    });
  });

  // A tampered/invalid token must not pass verification.
  it('rejects a request bearing an invalid token with 401', async () => {
    await request(app.getHttpServer())
      .get('/api/me')
      .set('Authorization', 'Bearer not.a.valid.token')
      .expect(401);
  });
});
