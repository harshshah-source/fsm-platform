import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * Issue 02, Slice 4 — user accounts as Operations-Head-owned reference data (`/api/org/users`).
 * Additive: this is the RBAC/account registry (no credentials here); the login path stays on the
 * in-memory store for now (decision 2026-06-18). Satisfies AC#4 (accounts manageable for all roles).
 */
describe('Issue 02 Slice 4 — /api/org/users (user account management)', () => {
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

  function newUser(role = 'WAREHOUSE_MANAGER'): {
    name: string;
    role: string;
    email: string;
    phone: string;
  } {
    const tag = randomUUID().slice(0, 8);
    return { name: `User ${tag}`, role, email: `u_${tag}@fsm.test`, phone: `+91${tag}` };
  }

  it('lets Operations Head create a user account and lists it', async () => {
    const token = await login('ops.head@fsm.test');
    const body = newUser('WAREHOUSE_MANAGER');

    const created = await request(app.getHttpServer())
      .post('/api/org/users')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(201);
    expect(created.body.userId).toEqual(expect.any(String));
    expect(created.body.email).toBe(body.email);
    expect(created.body.role).toBe('WAREHOUSE_MANAGER');
    expect(created.body.status).toBe('ACTIVE');

    const list = await request(app.getHttpServer())
      .get('/api/org/users')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body.some((u: { email: string }) => u.email === body.email)).toBe(true);
  });

  it('disables a user account (PATCH status)', async () => {
    const token = await login('ops.head@fsm.test');
    const created = await request(app.getHttpServer())
      .post('/api/org/users')
      .set('Authorization', `Bearer ${token}`)
      .send(newUser('SERVICE_ENGINEER'))
      .expect(201);

    const disabled = await request(app.getHttpServer())
      .patch(`/api/org/users/${created.body.userId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'DISABLED' })
      .expect(200);
    expect(disabled.body.status).toBe('DISABLED');
  });

  it('rejects a duplicate email with 409', async () => {
    const token = await login('ops.head@fsm.test');
    const body = newUser('CENTRAL_SERVICE_MANAGER');
    await request(app.getHttpServer())
      .post('/api/org/users')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/org/users')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...body, phone: `+91${randomUUID().slice(0, 8)}` })
      .expect(409);
  });

  it('rejects a non-Operations-Head writer with 403', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/org/users')
      .set('Authorization', `Bearer ${token}`)
      .send(newUser())
      .expect(403);
  });
});
