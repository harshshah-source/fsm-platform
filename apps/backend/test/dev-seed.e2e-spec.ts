import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DEV_SEED_FIXTURE_EMAILS, runDevSeed } from '../src/auth/dev-seed';
import { PrismaService } from '../src/prisma/prisma.service';

function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

/**
 * #194 — the dev-login seeder against a real database.
 *
 * The pure guard lives in `dev-seed.spec.ts`; this file covers the three properties that only a
 * database can show: that it creates the credential rows when they are missing (the actual defect —
 * `user_credentials` measured at **0 rows** on the dev DB), that it writes nothing else, and that a
 * database it has prepared can actually authenticate. That last one is AC-7's purpose: #91 S4 removed
 * the implicit dev-login provision and no test noticed, so the replacement gets a tripwire.
 *
 * Creation-from-empty is proven inside a transaction that is deliberately rolled back. The suite
 * shares one long-lived `fsm_test` database that is never truncated between files (#156), so a test
 * that really deleted the fixture credentials would 401 every login in every file that ran after it.
 */
describe('#194 dev-login seed (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const ALLOWED_ENV = { ALLOW_DEV_SEED: 'true', NODE_ENV: 'test' };

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

  it('refuses to touch the database at all when the opt-in is absent', async () => {
    await expect(runDevSeed(prisma, { NODE_ENV: 'development' })).rejects.toThrow(/ALLOW_DEV_SEED/);
    await expect(runDevSeed(prisma, { ALLOW_DEV_SEED: 'true', NODE_ENV: 'production' })).rejects.toThrow(
      /production/i,
    );
  });

  it('creates a credential for every fixture account when the table is empty', async () => {
    // Rolled back — see the file docstring. `$transaction` gives a client scoped to the transaction,
    // so the seeder's writes and our deletes vanish together when the callback throws.
    const ROLLBACK = new Error('rollback');
    const observed = await prisma
      .$transaction(async (tx) => {
        await tx.userCredential.deleteMany({
          where: { user: { email: { in: [...DEV_SEED_FIXTURE_EMAILS] } } },
        });
        expect(
          await tx.userCredential.count({ where: { user: { email: { in: [...DEV_SEED_FIXTURE_EMAILS] } } } }),
        ).toBe(0);

        const summary = await runDevSeed(tx, ALLOWED_ENV);
        const after = await tx.userCredential.count({
          where: { user: { email: { in: [...DEV_SEED_FIXTURE_EMAILS] } } },
        });

        // Re-running inside the same transaction must not duplicate or throw (AC-2, idempotent).
        await runDevSeed(tx, ALLOWED_ENV);
        const afterSecond = await tx.userCredential.count({
          where: { user: { email: { in: [...DEV_SEED_FIXTURE_EMAILS] } } },
        });

        const zms = await tx.user.findMany({
          where: { email: { in: ['zm.north@fsm.test', 'zm.south@fsm.test', 'zm.east@fsm.test', 'zm.west@fsm.test'] } },
          select: { email: true, zoneId: true },
          orderBy: { email: 'asc' },
        });

        const captured = { summary, after, afterSecond, zms };
        Object.assign(ROLLBACK, { captured });
        throw ROLLBACK;
      })
      .catch((err: unknown) => {
        if (err !== ROLLBACK) throw err;
        return (ROLLBACK as Error & { captured: Record<string, unknown> }).captured;
      });

    expect(observed.after).toBe(DEV_SEED_FIXTURE_EMAILS.length);
    expect(observed.afterSecond).toBe(DEV_SEED_FIXTURE_EMAILS.length);
    expect(observed.summary).toMatchObject({ accounts: DEV_SEED_FIXTURE_EMAILS.length });

    // Every ZM carries a zone — the preflight's reason for existing (a null zone_id is a login that
    // authenticates and then 403s on every zone-scoped route).
    for (const zm of observed.zms as { email: string; zoneId: number | null }[]) {
      expect(zm.zoneId, `${zm.email} must be scoped to a zone`).not.toBeNull();
    }
  });

  it('creates only users and credentials — no reference, device or ticket rows (AC-2)', async () => {
    const census = async () => ({
      zones: await prisma.zone.count(),
      plants: await prisma.plant.count(),
      devices: await prisma.device.count(),
      tickets: await prisma.ticket.count(),
      users: await prisma.user.count(),
      credentials: await prisma.userCredential.count(),
    });

    const before = await census();
    await runDevSeed(prisma, ALLOWED_ENV);
    const after = await census();

    expect(after).toEqual(before);
  });

  it('leaves a database it prepared able to authenticate a manager role (AC-7)', async () => {
    await runDevSeed(prisma, ALLOWED_ENV);

    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'ops.head@fsm.test', password: 'correct-password' })
      .expect(200);

    expect(res.body.accessToken).toBeTruthy();
    const claims = decodeJwtPayload(res.body.accessToken as string);
    expect(claims.role).toBe('OPERATIONS_HEAD');
  });
});
