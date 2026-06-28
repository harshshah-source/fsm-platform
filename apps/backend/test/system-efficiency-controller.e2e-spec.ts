import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * Issue 42 — the `/api/reports/efficiency` HTTP surface (RBAC + routing + the OH recompute trigger). The
 * metric computation itself is covered by the SystemEfficiencyAggregationService e2e spec.
 */
describe('/api/reports/efficiency (e2e)', () => {
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
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  }

  it('Operations Head recomputes a day, then the report returns a fleet rollup + per-zone breakdown', async () => {
    const oh = await login('ops.head@fsm.test');
    const recompute = await request(app.getHttpServer())
      .post('/api/reports/efficiency/recompute?day=2026-06-19')
      .set('Authorization', `Bearer ${oh}`)
      .expect(200);
    expect(recompute.body.day).toBe('2026-06-19');

    const report = await request(app.getHttpServer())
      .get('/api/reports/efficiency?from=2026-06-19&to=2026-06-19')
      .set('Authorization', `Bearer ${oh}`)
      .expect(200);
    expect(report.body.fleet).toBeDefined();
    expect(Array.isArray(report.body.byZone)).toBe(true);
    expect(typeof report.body.fleet.slaCompliancePct).toBe('number');
  });

  it('forbids an SE', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer()).get('/api/reports/efficiency').set('Authorization', `Bearer ${token}`).expect(403);
  });

  it('forbids a ZM from triggering the recompute (Operations-Head only)', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer()).post('/api/reports/efficiency/recompute').set('Authorization', `Bearer ${token}`).expect(403);
  });

  it('400s an invalid day range', async () => {
    const oh = await login('ops.head@fsm.test');
    await request(app.getHttpServer())
      .get('/api/reports/efficiency?from=2026-06-20&to=2026-06-10')
      .set('Authorization', `Bearer ${oh}`)
      .expect(400);
  });

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer()).get('/api/reports/efficiency').expect(401);
  });
});
