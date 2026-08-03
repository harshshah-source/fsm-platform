import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { ensureCredential } from '../src/auth/credential-seed';
import { PrismaService } from '../src/prisma/prisma.service';

function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

/**
 * Issue #91 S2 — DB-backed login. Proves login resolves ANY `users` row (+ a `user_credentials` row)
 * from Postgres, not the retired `InMemoryUserStore`'s 5/8 hardcoded accounts — the generic property
 * the issue's AC framing calls out ("authentication simply authenticates valid database users").
 */
describe('DB-backed login (#91 S2)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  async function login(email: string, password: string): Promise<request.Response> {
    return request(app.getHttpServer()).post('/api/auth/login').send({ email, password });
  }

  it('logs in a user inserted directly into `users` + `user_credentials` (RED before #91: no such path existed)', async () => {
    const tag = randomUUID().slice(0, 8);
    const email = `direct-${tag}@fsm.test`;
    const user = await prisma.user.create({
      data: { name: 'Direct DB User', role: 'SERVICE_ENGINEER', phone: `db-${tag}`, email },
    });
    await ensureCredential(prisma, user.userId, 'a-real-password');

    const res = await login(email, 'a-real-password');
    expect(res.status).toBe(200);
    const claims = decodeJwtPayload(res.body.accessToken as string);
    expect(claims.user_id).toBe(user.userId);
    expect(claims.role).toBe('SERVICE_ENGINEER');
  });

  it('rejects a wrong password for a real DB user with 401', async () => {
    const tag = randomUUID().slice(0, 8);
    const email = `wrongpw-${tag}@fsm.test`;
    const user = await prisma.user.create({
      data: { name: 'Wrong PW User', role: 'SERVICE_ENGINEER', phone: `db-${tag}`, email },
    });
    await ensureCredential(prisma, user.userId, 'a-real-password');

    const res = await login(email, 'not-the-password');
    expect(res.status).toBe(401);
  });

  it('rejects an unknown email with 401', async () => {
    const res = await login(`nobody-${randomUUID()}@fsm.test`, 'whatever');
    expect(res.status).toBe(401);
  });

  it('rejects login for a `users` row that has no credential yet (org-CRUD gap, pre-credential)', async () => {
    const tag = randomUUID().slice(0, 8);
    const email = `nocred-${tag}@fsm.test`;
    await prisma.user.create({
      data: { name: 'No Credential Yet', role: 'SERVICE_ENGINEER', phone: `db-${tag}`, email },
    });

    const res = await login(email, 'anything');
    expect(res.status).toBe(401);
  });

  // "Organization-seeded users" AC: a user created via POST /api/org/users, once GIVEN a credential,
  // can immediately log in — the "DB user exists but cannot authenticate" gap #91 exists to close.
  it('org-CRUD-created user logs in once a credential is issued for them', async () => {
    const opsToken = (
      await login('ops.head@fsm.test', 'correct-password')
    ).body.accessToken as string;

    const tag = randomUUID().slice(0, 8);
    const email = `orgcrud-${tag}@fsm.test`;
    const created = await request(app.getHttpServer())
      .post('/api/org/users')
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ name: 'Org CRUD User', role: 'ZONAL_MANAGER', email, phone: `org-${tag}` })
      .expect(201);

    // Not loginable yet — no credential issued.
    expect((await login(email, 'new-password')).status).toBe(401);

    await ensureCredential(prisma, created.body.userId as string, 'new-password');

    const res = await login(email, 'new-password');
    expect(res.status).toBe(200);
    const claims = decodeJwtPayload(res.body.accessToken as string);
    expect(claims.user_id).toBe(created.body.userId);
    expect(claims.role).toBe('ZONAL_MANAGER');
  });
});
