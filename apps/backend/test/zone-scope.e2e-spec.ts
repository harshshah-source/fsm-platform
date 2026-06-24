import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('ZoneScopeGuard (e2e)', () => {
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

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  }

  // TB5: a Zonal Manager touching another zone is rejected with 403 ZONE_SCOPE_VIOLATION.
  it('forbids a Zonal Manager from another zone with 403 ZONE_SCOPE_VIOLATION', async () => {
    const token = await login('zm.north@fsm.test'); // zone 1
    const res = await request(app.getHttpServer())
      .get('/api/zones/2')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    expect(res.body.message).toBe('ZONE_SCOPE_VIOLATION');
  });

  it('allows a Zonal Manager within their own zone', async () => {
    const token = await login('zm.north@fsm.test'); // zone 1
    await request(app.getHttpServer())
      .get('/api/zones/1')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('allows a cross-zone role (OPERATIONS_HEAD) into any zone', async () => {
    const token = await login('ops.head@fsm.test'); // zone null, cross-zone
    await request(app.getHttpServer())
      .get('/api/zones/2')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });
});
