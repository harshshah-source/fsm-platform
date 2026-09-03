import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { ensureCredential } from '../src/auth/credential-seed';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 02, Slice 4 — user accounts as Operations-Head-owned reference data (`/api/org/users`).
 * Additive: this is the RBAC/account registry only — it does not mint a credential, so a freshly
 * created account cannot log in until one is issued (see `db-backed-login.e2e-spec.ts`, #91 S2, for
 * the "org-CRUD user login" AC once a credential exists).
 */
describe('Issue 02 Slice 4 — /api/org/users (user account management)', () => {
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

  /**
   * #362 — completing user administration. Two things here are not CRUD:
   *
   * **Revocation.** A role or zone is only half of what a principal can reach; the other half is the
   * access token already in their hand and the refresh token that keeps minting more. Demoting a CSM
   * to Warehouse Manager while their session keeps refreshing on the old claims means the demotion is
   * recorded in the audit log and has not happened — which is worse than not demoting at all, because
   * the log now says it did. So a scope change ends the sessions carrying the old scope.
   *
   * **The last Operations Head.** OH is the only role that can administer users. Demote or disable
   * the last active one and the change cannot be undone from inside the product — it becomes a
   * database-console incident. The guard counts *other active* OHs, not OH rows, so a disabled OH
   * does not count as a way back in.
   */
  describe('#362 — role/zone change, session revocation, last-OH guard', () => {
    /** Logs in and returns the whole token pair — the refresh token is the thing under test. */
    async function loginPair(
      email: string,
      password = 'correct-password',
    ): Promise<{ accessToken: string; refreshToken: string }> {
      const res = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email, password })
        .expect(200);
      return res.body as { accessToken: string; refreshToken: string };
    }

    /** Creates an account through the API and gives it a credential, so it can hold a live session. */
    async function createLoginableUser(
      opsToken: string,
      role: string,
      zoneId?: number,
    ): Promise<{ userId: string; email: string; refreshToken: string }> {
      const body = { ...newUser(role), ...(zoneId === undefined ? {} : { zoneId }) };
      const created = await request(app.getHttpServer())
        .post('/api/org/users')
        .set('Authorization', `Bearer ${opsToken}`)
        .send(body)
        .expect(201);
      const userId = created.body.userId as string;
      await ensureCredential(prisma, userId, 'session-password');
      const pair = await loginPair(body.email, 'session-password');
      return { userId, email: body.email, refreshToken: pair.refreshToken };
    }

    async function firstZoneId(opsToken: string): Promise<number> {
      const zones = await request(app.getHttpServer())
        .get('/api/org/zones')
        .set('Authorization', `Bearer ${opsToken}`)
        .expect(200);
      return zones.body[0].zoneId as number;
    }

    /**
     * Runs `run` in a world where `keepEmail` is provably the only active Operations Head, then puts
     * back exactly what it parked. Without this the last-OH assertions would depend on whether some
     * earlier spec file happened to leave a second OH behind — the suite shares one database, and a
     * security invariant that only holds in a particular file order is not pinned at all.
     */
    async function asSoleOpsHead<T>(keepEmail: string, run: () => Promise<T>): Promise<T> {
      const heads = await prisma.user.findMany({
        where: { role: 'OPERATIONS_HEAD', status: 'ACTIVE' },
      });
      const kept = heads.find((h) => h.email === keepEmail);
      if (!kept) throw new Error(`Expected an active Operations Head ${keepEmail}`);
      const parked = heads.filter((h) => h.userId !== kept.userId).map((h) => h.userId);
      if (parked.length > 0) {
        await prisma.user.updateMany({
          where: { userId: { in: parked } },
          data: { status: 'DISABLED' },
        });
      }
      try {
        return await run();
      } finally {
        if (parked.length > 0) {
          await prisma.user.updateMany({
            where: { userId: { in: parked } },
            data: { status: 'ACTIVE' },
          });
        }
      }
    }

    const activeTokens = (userId: string) =>
      prisma.refreshToken.count({ where: { userId, revokedAt: null } });

    it('AC1 — changes a user role and zone in one PATCH', async () => {
      const opsToken = await login('ops.head@fsm.test');
      const zoneId = await firstZoneId(opsToken);
      const created = await request(app.getHttpServer())
        .post('/api/org/users')
        .set('Authorization', `Bearer ${opsToken}`)
        .send(newUser('WAREHOUSE_MANAGER'))
        .expect(201);

      const updated = await request(app.getHttpServer())
        .patch(`/api/org/users/${created.body.userId}`)
        .set('Authorization', `Bearer ${opsToken}`)
        .send({ role: 'ZONAL_MANAGER', zoneId })
        .expect(200);

      expect(updated.body.role).toBe('ZONAL_MANAGER');
      expect(updated.body.zoneId).toBe(zoneId);
    });

    it('AC2 — a role change kills the live session end to end (refresh → 401)', async () => {
      const opsToken = await login('ops.head@fsm.test');
      const subject = await createLoginableUser(opsToken, 'CENTRAL_SERVICE_MANAGER');

      // The session is genuinely live before the change — otherwise the 401 below proves nothing.
      const rotated = await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .send({ refreshToken: subject.refreshToken })
        .expect(200);

      await request(app.getHttpServer())
        .patch(`/api/org/users/${subject.userId}`)
        .set('Authorization', `Bearer ${opsToken}`)
        .send({ role: 'WAREHOUSE_MANAGER' })
        .expect(200);

      await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .send({ refreshToken: rotated.body.refreshToken as string })
        .expect(401);
      expect(await activeTokens(subject.userId)).toBe(0);
    });

    it('AC2 — a zone change revokes the session too, with a reason a support answer can read', async () => {
      const opsToken = await login('ops.head@fsm.test');
      const zoneId = await firstZoneId(opsToken);
      const subject = await createLoginableUser(opsToken, 'ZONAL_MANAGER', zoneId);

      const zones = await request(app.getHttpServer())
        .get('/api/org/zones')
        .set('Authorization', `Bearer ${opsToken}`)
        .expect(200);
      const otherZoneId = (zones.body as { zoneId: number }[]).find((z) => z.zoneId !== zoneId)
        ?.zoneId;
      expect(otherZoneId).toBeDefined();

      await request(app.getHttpServer())
        .patch(`/api/org/users/${subject.userId}`)
        .set('Authorization', `Bearer ${opsToken}`)
        .send({ zoneId: otherZoneId })
        .expect(200);

      expect(await activeTokens(subject.userId)).toBe(0);
      const revoked = await prisma.refreshToken.findFirst({
        where: { userId: subject.userId },
        orderBy: { id: 'desc' },
      });
      expect(revoked?.revokedReason).toBe('ROLE_OR_ZONE_CHANGED');
    });

    it('AC2 — a PATCH that changes nothing does not log the user out', async () => {
      // The revocation is keyed on an actual scope change, not on the route being called. An OH
      // re-saving a row unchanged must not evict a working engineer from the field.
      const opsToken = await login('ops.head@fsm.test');
      const zoneId = await firstZoneId(opsToken);
      const subject = await createLoginableUser(opsToken, 'ZONAL_MANAGER', zoneId);

      await request(app.getHttpServer())
        .patch(`/api/org/users/${subject.userId}`)
        .set('Authorization', `Bearer ${opsToken}`)
        .send({ role: 'ZONAL_MANAGER', zoneId })
        .expect(200);

      expect(await activeTokens(subject.userId)).toBe(1);
      await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .send({ refreshToken: subject.refreshToken })
        .expect(200);
    });

    it('AC2 — disabling an account ends its session as well', async () => {
      const opsToken = await login('ops.head@fsm.test');
      const subject = await createLoginableUser(opsToken, 'SERVICE_ENGINEER');

      await request(app.getHttpServer())
        .patch(`/api/org/users/${subject.userId}`)
        .set('Authorization', `Bearer ${opsToken}`)
        .send({ status: 'DISABLED' })
        .expect(200);

      expect(await activeTokens(subject.userId)).toBe(0);
      await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .send({ refreshToken: subject.refreshToken })
        .expect(401);
    });

    it('audits the change as USER_UPDATED carrying what it changed from and to', async () => {
      const opsToken = await login('ops.head@fsm.test');
      const created = await request(app.getHttpServer())
        .post('/api/org/users')
        .set('Authorization', `Bearer ${opsToken}`)
        .send(newUser('WAREHOUSE_MANAGER'))
        .expect(201);

      await request(app.getHttpServer())
        .patch(`/api/org/users/${created.body.userId}`)
        .set('Authorization', `Bearer ${opsToken}`)
        .send({ role: 'CENTRAL_SERVICE_MANAGER' })
        .expect(200);

      const row = await prisma.auditLog.findFirst({
        where: {
          action: 'USER_UPDATED',
          entityType: 'users',
          entityId: created.body.userId as string,
        },
        orderBy: { id: 'desc' },
      });
      expect(row).not.toBeNull();
      expect(row?.metadata).toMatchObject({
        from: { role: 'WAREHOUSE_MANAGER' },
        to: { role: 'CENTRAL_SERVICE_MANAGER' },
      });
    });

    it('AC3 — refuses to demote the last active Operations Head', async () => {
      const opsToken = await login('ops.head@fsm.test');
      await asSoleOpsHead('ops.head@fsm.test', async () => {
        const me = await prisma.user.findUnique({ where: { email: 'ops.head@fsm.test' } });
        const res = await request(app.getHttpServer())
          .patch(`/api/org/users/${me!.userId}`)
          .set('Authorization', `Bearer ${opsToken}`)
          .send({ role: 'ZONAL_MANAGER' })
          .expect(409);
        expect(res.body.code).toBe('LAST_OPERATIONS_HEAD');

        const after = await prisma.user.findUnique({ where: { userId: me!.userId } });
        expect(after?.role).toBe('OPERATIONS_HEAD');
      });
    });

    it('AC3 — refuses to disable the last active Operations Head', async () => {
      const opsToken = await login('ops.head@fsm.test');
      await asSoleOpsHead('ops.head@fsm.test', async () => {
        const me = await prisma.user.findUnique({ where: { email: 'ops.head@fsm.test' } });
        await request(app.getHttpServer())
          .patch(`/api/org/users/${me!.userId}`)
          .set('Authorization', `Bearer ${opsToken}`)
          .send({ status: 'DISABLED' })
          .expect(409);

        const after = await prisma.user.findUnique({ where: { userId: me!.userId } });
        expect(after?.status).toBe('ACTIVE');
      });
    });

    it('AC3 — a disabled Operations Head is not a way back in (it does not count as a survivor)', async () => {
      const opsToken = await login('ops.head@fsm.test');
      const spare = await request(app.getHttpServer())
        .post('/api/org/users')
        .set('Authorization', `Bearer ${opsToken}`)
        .send(newUser('OPERATIONS_HEAD'))
        .expect(201);
      await prisma.user.update({
        where: { userId: spare.body.userId as string },
        data: { status: 'DISABLED' },
      });

      await asSoleOpsHead('ops.head@fsm.test', async () => {
        const me = await prisma.user.findUnique({ where: { email: 'ops.head@fsm.test' } });
        await request(app.getHttpServer())
          .patch(`/api/org/users/${me!.userId}`)
          .set('Authorization', `Bearer ${opsToken}`)
          .send({ role: 'ZONAL_MANAGER' })
          .expect(409);
      });
    });

    it('AC3 — demotes an Operations Head while another active one remains', async () => {
      const opsToken = await login('ops.head@fsm.test');
      const spare = await request(app.getHttpServer())
        .post('/api/org/users')
        .set('Authorization', `Bearer ${opsToken}`)
        .send(newUser('OPERATIONS_HEAD'))
        .expect(201);

      const demoted = await request(app.getHttpServer())
        .patch(`/api/org/users/${spare.body.userId}`)
        .set('Authorization', `Bearer ${opsToken}`)
        .send({ role: 'WAREHOUSE_MANAGER' })
        .expect(200);
      expect(demoted.body.role).toBe('WAREHOUSE_MANAGER');
    });

    it('rejects an unknown role with 400 and an unknown zone with 400', async () => {
      const opsToken = await login('ops.head@fsm.test');
      const created = await request(app.getHttpServer())
        .post('/api/org/users')
        .set('Authorization', `Bearer ${opsToken}`)
        .send(newUser('WAREHOUSE_MANAGER'))
        .expect(201);

      await request(app.getHttpServer())
        .patch(`/api/org/users/${created.body.userId}`)
        .set('Authorization', `Bearer ${opsToken}`)
        .send({ role: 'SUPREME_LEADER' })
        .expect(400);
      await request(app.getHttpServer())
        .patch(`/api/org/users/${created.body.userId}`)
        .set('Authorization', `Bearer ${opsToken}`)
        .send({ zoneId: 999999 })
        .expect(400);
      await request(app.getHttpServer())
        .patch(`/api/org/users/${created.body.userId}`)
        .set('Authorization', `Bearer ${opsToken}`)
        .send({})
        .expect(400);
    });

    it('404s on an unknown user and 403s a non-Operations-Head editor', async () => {
      const opsToken = await login('ops.head@fsm.test');
      await request(app.getHttpServer())
        .patch(`/api/org/users/${randomUUID()}`)
        .set('Authorization', `Bearer ${opsToken}`)
        .send({ role: 'ZONAL_MANAGER' })
        .expect(404);

      const created = await request(app.getHttpServer())
        .post('/api/org/users')
        .set('Authorization', `Bearer ${opsToken}`)
        .send(newUser('SERVICE_ENGINEER'))
        .expect(201);
      const zmToken = await login('zm.north@fsm.test');
      await request(app.getHttpServer())
        .patch(`/api/org/users/${created.body.userId}`)
        .set('Authorization', `Bearer ${zmToken}`)
        .send({ role: 'CENTRAL_SERVICE_MANAGER' })
        .expect(403);
    });
  });
});
