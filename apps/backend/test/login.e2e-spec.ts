import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

describe('Login (e2e)', () => {
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

  // TB2: a valid login issues an access token whose claims carry user_id, role and zone_id.
  it('issues an access token carrying user_id, role and zone_id on valid login', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'zm.north@fsm.test', password: 'correct-password' })
      .expect(200);

    expect(typeof res.body.accessToken).toBe('string');

    const claims = decodeJwtPayload(res.body.accessToken as string);
    expect(claims.user_id).toBe('11111111-1111-1111-1111-111111111111');
    expect(claims.role).toBe('ZONAL_MANAGER');
    expect(claims.zone_id).toBe(1);
  });
});
