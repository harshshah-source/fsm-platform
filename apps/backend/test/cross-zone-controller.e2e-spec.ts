import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * Issue 32 — the `/api/cross-zone/*` HTTP surface (RBAC + routing + input validation). The escalation
 * behaviours themselves are covered by the CrossZoneEscalationService e2e spec.
 */
describe('/api/cross-zone (e2e)', () => {
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

  it('lets a CSM read the cross-zone queue', async () => {
    const token = await login('csm@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/cross-zone')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('forbids an SE from the cross-zone queue', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .get('/api/cross-zone')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('forbids a ZM from approving (decider-only action)', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/cross-zone/999999999/approve')
      .set('Authorization', `Bearer ${token}`)
      .send({ targetZoneId: 1, seId: '00000000-0000-0000-0000-0000000000aa' })
      .expect(403);
  });

  it('400s a flag with a missing reason', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/cross-zone/flag')
      .set('Authorization', `Bearer ${token}`)
      .send({ ticketId: '00000000-0000-0000-0000-0000000000aa' })
      .expect(400);
  });

  it('404s a deny on an unknown escalation', async () => {
    const token = await login('csm@fsm.test');
    await request(app.getHttpServer())
      .post('/api/cross-zone/999999999/deny')
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'nope' })
      .expect(404);
  });

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer()).get('/api/cross-zone').expect(401);
  });
});
