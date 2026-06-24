import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * Issue 02, Slice 5 — company_master as reference data (`/api/org/companies`). Tier + priority
 * rank are the recommender's top-level scoring gate / tie-break (schema D1, AC#3). Consumed by
 * Issue 06 (Company/Plant overview) and Issue 10 (canonical scoring sort).
 */
describe('Issue 02 Slice 5 — /api/org/companies (company tier/rank)', () => {
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

  it('lets Operations Head create a company with tier + rank and lists it', async () => {
    const token = await login('ops.head@fsm.test');
    const name = `Acme ${randomUUID().slice(0, 8)}`;

    const created = await request(app.getHttpServer())
      .post('/api/org/companies')
      .set('Authorization', `Bearer ${token}`)
      .send({ name, companyTier: 'PLATINUM', companyPriorityRank: 'A' })
      .expect(201);
    expect(created.body.companyId).toEqual(expect.any(Number));
    expect(created.body.companyTier).toBe('PLATINUM');
    expect(created.body.companyPriorityRank).toBe('A');
    expect(created.body.opsOverride).toBe(false);

    const list = await request(app.getHttpServer())
      .get('/api/org/companies')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body.some((c: { name: string }) => c.name === name)).toBe(true);
  });

  it('rejects an invalid tier with 400', async () => {
    const token = await login('ops.head@fsm.test');
    await request(app.getHttpServer())
      .post('/api/org/companies')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Bad Tier', companyTier: 'BRONZE', companyPriorityRank: 'A' })
      .expect(400);
  });

  it('rejects an invalid priority rank with 400', async () => {
    const token = await login('ops.head@fsm.test');
    await request(app.getHttpServer())
      .post('/api/org/companies')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Bad Rank', companyTier: 'GOLD', companyPriorityRank: 'AA' })
      .expect(400);
  });

  it('rejects a non-Operations-Head writer with 403', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/org/companies')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Nope', companyTier: 'SILVER', companyPriorityRank: 'B' })
      .expect(403);
  });
});
