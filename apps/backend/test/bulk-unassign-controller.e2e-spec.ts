import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * #179 Slice 1 — `POST /api/schedules/bulk-unassign` wiring. OH-only (D6, #119 precedent) —
 * unlike `dispatch-run`, the CSM does NOT get this control. Business logic is covered by
 * `bulk-unassign.e2e-spec.ts` / `bulk-unassign-execute.e2e-spec.ts`; this is role-guard + wiring.
 */
describe('POST /api/schedules/bulk-unassign (e2e)', () => {
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
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  };

  it('lets Operations Head preview a zone-scoped bulk unassign', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .post('/api/schedules/bulk-unassign')
      .set('Authorization', `Bearer ${token}`)
      .send({ mode: 'PREVIEW', scope: 'ZONE', zoneId: 1, reasonCode: 'ROUTINE_REBALANCE' })
      .expect(200);
    expect(res.body).toMatchObject({
      operationId: expect.any(String),
      previewToken: expect.any(String),
      zones: expect.any(Array),
    });
  });

  it('forbids a Central Service Manager (unlike dispatch-run, this control is OH-only)', async () => {
    const token = await login('csm@fsm.test');
    await request(app.getHttpServer())
      .post('/api/schedules/bulk-unassign')
      .set('Authorization', `Bearer ${token}`)
      .send({ mode: 'PREVIEW', scope: 'ZONE', zoneId: 1, reasonCode: 'ROUTINE_REBALANCE' })
      .expect(403);
  });

  it('forbids a Service Engineer', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/schedules/bulk-unassign')
      .set('Authorization', `Bearer ${token}`)
      .send({ mode: 'PREVIEW', scope: 'ZONE', zoneId: 1, reasonCode: 'ROUTINE_REBALANCE' })
      .expect(403);
  });

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer())
      .post('/api/schedules/bulk-unassign')
      .send({ mode: 'PREVIEW', scope: 'ZONE', zoneId: 1, reasonCode: 'ROUTINE_REBALANCE' })
      .expect(401);
  });

  it('rejects a ZONE-scoped request with no zoneId', async () => {
    const token = await login('ops.head@fsm.test');
    await request(app.getHttpServer())
      .post('/api/schedules/bulk-unassign')
      .set('Authorization', `Bearer ${token}`)
      .send({ mode: 'PREVIEW', scope: 'ZONE', reasonCode: 'ROUTINE_REBALANCE' })
      .expect(400);
  });

  it('rejects a request with no reasonCode', async () => {
    const token = await login('ops.head@fsm.test');
    await request(app.getHttpServer())
      .post('/api/schedules/bulk-unassign')
      .set('Authorization', `Bearer ${token}`)
      .send({ mode: 'PREVIEW', scope: 'ZONE', zoneId: 1 })
      .expect(400);
  });
});

describe('GET /api/schedules/bulk-unassign/history (e2e, #179 slice 4)', () => {
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
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  };

  it('lets Operations Head read the history list', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/schedules/bulk-unassign/history')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('forbids a Central Service Manager', async () => {
    const token = await login('csm@fsm.test');
    await request(app.getHttpServer())
      .get('/api/schedules/bulk-unassign/history')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer()).get('/api/schedules/bulk-unassign/history').expect(401);
  });
});
