import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * Issue 157, Slice 1 — `/api/org/tiers` (AC-1). Reference data behind the admin Companies dropdown
 * (replacing the hard-coded PLATINUM/GOLD/SILVER option list) and, from Slice 2 on, the tier
 * override create form (CSM/ZM). OH-gated for now, matching every other org reference endpoint.
 */
describe('Issue 157 Slice 1 — /api/org/tiers', () => {
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

  it('lists tiers ordered by rank ascending (highest priority first)', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/org/tiers')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body).toEqual([
      { name: 'PLATINUM', rank: 1 },
      { name: 'GOLD', rank: 2 },
      { name: 'SILVER', rank: 3 },
    ]);
  });

  it('rejects a non-Operations-Head reader with 403', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .get('/api/org/tiers')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });
});
