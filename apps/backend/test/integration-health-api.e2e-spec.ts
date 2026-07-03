import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * Phase 4/8 — `GET /api/integration/health` HTTP surface (blueprint §9). Verifies the controller +
 * guard chain end-to-end: Operations Head gets the health JSON; a Zonal Manager is forbidden; an
 * anonymous caller is unauthorized. In the test env AutoPlant is unconfigured, so `source.connected`
 * is false without any VPN — the endpoint still answers (freshness from the FSM run tables).
 */
describe('Phase 4 — GET /api/integration/health', () => {
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

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  };

  it('returns the integration health to Operations Head', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/integration/health')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.source).toMatchObject({ configured: false, connected: false });
    expect(res.body).toHaveProperty('masterSync');
    expect(res.body).toHaveProperty('snapshot');
    expect(res.body).toHaveProperty('checkedAt');
  });

  it('forbids a Zonal Manager', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .get('/api/integration/health')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('rejects an anonymous caller', async () => {
    await request(app.getHttpServer()).get('/api/integration/health').expect(401);
  });
});
