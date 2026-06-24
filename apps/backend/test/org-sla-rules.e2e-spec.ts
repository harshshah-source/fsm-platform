import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * Issue 02 Slice 7 — SLA rules (`sla_rule_config`). Operations Head tunes submit/verify/escalate
 * windows per device bucket or company tier without code changes (AC#3). Upsert keyed by
 * (scope, key); read by the SLA engine (Issue 05+).
 */
describe('Issue 02 Slice 7 — /api/org/sla-rules', () => {
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

  it('upserts an SLA rule and lists it', async () => {
    const token = await login('ops.head@fsm.test');
    const key = `tier-${randomUUID().slice(0, 8)}`;

    const created = await request(app.getHttpServer())
      .put('/api/org/sla-rules')
      .set('Authorization', `Bearer ${token}`)
      .send({
        scope: 'company_tier',
        key,
        submitWithinMinutes: 60,
        verifyWithinMinutes: 120,
        escalateAfterMinutes: 240,
      })
      .expect(200);
    expect(created.body.scope).toBe('company_tier');
    expect(created.body.submitWithinMinutes).toBe(60);

    // Re-PUT updates in place (no duplicate row).
    await request(app.getHttpServer())
      .put('/api/org/sla-rules')
      .set('Authorization', `Bearer ${token}`)
      .send({ scope: 'company_tier', key, submitWithinMinutes: 30 })
      .expect(200);

    const list = await request(app.getHttpServer())
      .get('/api/org/sla-rules')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const rows = list.body.filter((r: { key: string }) => r.key === key);
    expect(rows).toHaveLength(1);
    expect(rows[0].submitWithinMinutes).toBe(30);
  });

  it('rejects an invalid scope with 400', async () => {
    const token = await login('ops.head@fsm.test');
    await request(app.getHttpServer())
      .put('/api/org/sla-rules')
      .set('Authorization', `Bearer ${token}`)
      .send({ scope: 'galaxy', key: 'x', submitWithinMinutes: 10 })
      .expect(400);
  });

  it('rejects a negative SLA window with 400', async () => {
    const token = await login('ops.head@fsm.test');
    await request(app.getHttpServer())
      .put('/api/org/sla-rules')
      .set('Authorization', `Bearer ${token}`)
      .send({ scope: 'bucket', key: 'GOLD', submitWithinMinutes: -5 })
      .expect(400);
  });

  it('rejects a non-Operations-Head writer with 403', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .put('/api/org/sla-rules')
      .set('Authorization', `Bearer ${token}`)
      .send({ scope: 'bucket', key: 'A', submitWithinMinutes: 10 })
      .expect(403);
  });
});
