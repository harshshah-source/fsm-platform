import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * Issue 02 Slice 8 — Recommender scoring weights (`priority_rule_config`). Operations Head tunes
 * the weight set without code changes (AC#3); BatchAssignment stamps the active set into
 * recommendations (Issue 10). Upsert keyed by (weightSetRef, component).
 */
describe('Issue 02 Slice 8 — /api/org/scoring-weights', () => {
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

  it('upserts a scoring weight and lists it by weight set', async () => {
    const token = await login('ops.head@fsm.test');
    const ref = `v-${randomUUID().slice(0, 8)}`;

    const created = await request(app.getHttpServer())
      .post('/api/org/scoring-weights')
      .set('Authorization', `Bearer ${token}`)
      .send({ weightSetRef: ref, component: 'company_tier', weight: 0.5 })
      .expect(201);
    expect(created.body.weight).toBe(0.5);
    expect(created.body.active).toBe(true);

    await request(app.getHttpServer())
      .post('/api/org/scoring-weights')
      .set('Authorization', `Bearer ${token}`)
      .send({ weightSetRef: ref, component: 'company_tier', weight: 0.75 })
      .expect(201);

    const list = await request(app.getHttpServer())
      .get(`/api/org/scoring-weights?weightSetRef=${ref}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].weight).toBe(0.75);
  });

  it('rejects a non-numeric weight with 400', async () => {
    const token = await login('ops.head@fsm.test');
    await request(app.getHttpServer())
      .post('/api/org/scoring-weights')
      .set('Authorization', `Bearer ${token}`)
      .send({ weightSetRef: 'v1', component: 'x', weight: 'heavy' })
      .expect(400);
  });

  it('rejects a non-Operations-Head writer with 403', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/org/scoring-weights')
      .set('Authorization', `Bearer ${token}`)
      .send({ weightSetRef: 'v1', component: 'x', weight: 1 })
      .expect(403);
  });
});
