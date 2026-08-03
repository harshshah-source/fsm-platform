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
 * Issue #91 — "Book-imported users authenticate with NO Book-specific code path" AC. The full Book8
 * harness (`test/env/book8/`) is opt-in (`BOOK8_RUN=1`, ~30min, exercises the whole ingestion →
 * recommender pipeline) and out of scope to run for an auth-only check. This spec instead creates
 * users with the SAME email convention `book8-se-org.ts` uses (`zm-<zone>@book8.test`,
 * `ops-head@book8.test`, etc.) via the same generic `users.create` + `ensureCredential` path
 * `book8-se-org.ts`'s `ensureUser` now calls — proving login is generic (any DB user + credential
 * logs in identically), which is the actual property this AC cares about.
 */
describe('Book-shaped role logins — no Book-specific code path (#91)', () => {
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

  async function ensureBookUser(
    email: string,
    role: string,
    zoneName: string | null,
    phone: string,
  ): Promise<{ userId: string; zoneId: number | null }> {
    const zoneId = zoneName
      ? (await prisma.zone.findUniqueOrThrow({ where: { name: zoneName } })).zoneId
      : null;
    const existing = await prisma.user.findFirst({ where: { email } });
    const user =
      existing ??
      (await prisma.user.create({
        data: { name: email, role: role as never, phone, email, zoneId: zoneId ?? undefined },
      }));
    await ensureCredential(prisma, user.userId, 'correct-password');
    return { userId: user.userId, zoneId: zoneId === null ? null : Number(zoneId) };
  }

  async function login(email: string): Promise<Record<string, unknown>> {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return decodeJwtPayload(res.body.accessToken as string);
  }

  it('ops-head@book8.test (OPERATIONS_HEAD, zone_id null) logs in with correct claims', async () => {
    await ensureBookUser('ops-head@book8.test', 'OPERATIONS_HEAD', null, 'book-t-oh');
    const claims = await login('ops-head@book8.test');
    expect(claims.role).toBe('OPERATIONS_HEAD');
    expect(claims.zone_id).toBeNull();
  });

  it('csm@book8.test (CENTRAL_SERVICE_MANAGER, zone_id null) logs in with correct claims', async () => {
    await ensureBookUser('csm@book8.test', 'CENTRAL_SERVICE_MANAGER', null, 'book-t-csm');
    const claims = await login('csm@book8.test');
    expect(claims.role).toBe('CENTRAL_SERVICE_MANAGER');
    expect(claims.zone_id).toBeNull();
  });

  it('zm-north@book8.test (ZONAL_MANAGER, zone_id set) logs in with correct claims', async () => {
    const { zoneId } = await ensureBookUser('zm-north@book8.test', 'ZONAL_MANAGER', 'North', 'book-t-zm');
    const claims = await login('zm-north@book8.test');
    expect(claims.role).toBe('ZONAL_MANAGER');
    expect(claims.zone_id).toBe(zoneId);
  });

  it('wm@book8.test (WAREHOUSE_MANAGER) logs in with correct claims', async () => {
    await ensureBookUser('wm@book8.test', 'WAREHOUSE_MANAGER', null, 'book-t-wm');
    const claims = await login('wm@book8.test');
    expect(claims.role).toBe('WAREHOUSE_MANAGER');
  });

  it('se-1-0@book8.test (SERVICE_ENGINEER, zone_id set) logs in with correct claims', async () => {
    const { zoneId } = await ensureBookUser('se-1-0@book8.test', 'SERVICE_ENGINEER', 'South', 'book-t-se');
    const claims = await login('se-1-0@book8.test');
    expect(claims.role).toBe('SERVICE_ENGINEER');
    expect(claims.zone_id).toBe(zoneId);
  });
});
