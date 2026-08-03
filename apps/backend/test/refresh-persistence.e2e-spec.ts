import { createHash, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue #91 S3 — persistent refresh tokens with device binding, one-active-device (D-2), and
 * restart-survival. `refresh.e2e-spec.ts` stays the untouched rotation-contract regression baseline;
 * this file covers the NEW behavior the Postgres-backed store adds.
 */
describe('Refresh-token persistence + device binding (#91 S3)', () => {
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

  async function login(deviceId?: string): Promise<{ accessToken: string; refreshToken: string }> {
    const req = request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'wm@fsm.test', password: 'correct-password' });
    if (deviceId) req.set('X-Device-Id', deviceId);
    const res = await req.expect(200);
    return res.body;
  }

  // The one test that matters most: prove PERSISTENCE, not just that the interface works. A fresh,
  // independently-constructed PrismaService (a new connection, not the app's) reads the row straight
  // out of Postgres by its hash — proving the token was never process-memory-only — and the running
  // app can still rotate it afterwards, exactly as if the process had restarted in between.
  it('a refresh token survives being read by a brand-new PrismaService instance, then still rotates', async () => {
    const { refreshToken } = await login(`device-${randomUUID()}`);

    const freshPrisma = new PrismaService();
    await freshPrisma.onModuleInit();
    try {
      const tokenHash = createHash('sha256').update(refreshToken).digest('hex');
      const row = await freshPrisma.refreshToken.findUnique({ where: { tokenHash } });
      expect(row).not.toBeNull();
      expect(row!.revokedAt).toBeNull();
      expect(row!.tokenHash).not.toBe(refreshToken); // only the hash is ever stored (schema invariant)
    } finally {
      await freshPrisma.onModuleDestroy();
    }

    // The token still rotates through the running app — proving the DB row (not any in-memory state)
    // is what `consume()` actually reads.
    const res = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .send({ refreshToken })
      .expect(200);
    expect(typeof res.body.refreshToken).toBe('string');
    expect(res.body.refreshToken).not.toBe(refreshToken);
  });

  // D-2 (SETTLED): logging in on a "new device" revokes the previous device's session.
  it('one-active-device: a login with a different X-Device-Id revokes the previous device session', async () => {
    const { refreshToken: deviceA } = await login('device-A');
    const { refreshToken: deviceB } = await login('device-B');
    expect(deviceB).not.toBe(deviceA);

    // Device A's refresh token was revoked the moment device B logged in.
    await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .send({ refreshToken: deviceA })
      .expect(401);

    // Device B's session is unaffected.
    await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .send({ refreshToken: deviceB })
      .expect(200);
  });

  it('a revoked (REPLACED_BY_NEW_DEVICE) token is rejected, not silently treated as unknown', async () => {
    const { refreshToken: deviceA } = await login('device-C');
    await login('device-D'); // revokes device-C's token

    const row = await prisma.refreshToken.findUnique({
      where: { tokenHash: createHash('sha256').update(deviceA).digest('hex') },
    });
    expect(row?.revokedAt).not.toBeNull();
    expect(row?.revokedReason).toBe('REPLACED_BY_NEW_DEVICE');
  });

  it('rotation without an X-Device-Id keeps the token attributed to its originating device', async () => {
    const deviceId = `device-${randomUUID()}`;
    const { refreshToken } = await login(deviceId);

    // Refresh sent with no X-Device-Id header — falls back to the consumed token's own deviceId.
    const res = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .send({ refreshToken })
      .expect(200);

    const row = await prisma.refreshToken.findUnique({
      where: {
        tokenHash: createHash('sha256').update(res.body.refreshToken as string).digest('hex'),
      },
    });
    expect(row?.deviceId).toBe(deviceId);
  });
});
