import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * DEV-ONLY scaffold test — remove with Issue #91 (see src/auth/dev-zone-resolver.ts).
 *
 * Proves the `DEV_AUTH_ZONE` opt-in lets the in-memory dev login adopt a LIVE seeded zone instead
 * of its frozen literal `zoneId: 1`, so the dev Zonal Manager keeps working after any org dataset is
 * loaded — without per-reseed code edits. Also proves the default (unset) path is byte-identical to
 * today (static zone, no DB read) and that fleet-wide roles are never touched.
 */
function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

describe('DevZoneResolver — DEV_AUTH_ZONE opt-in (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const original = process.env.DEV_AUTH_ZONE;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (original === undefined) delete process.env.DEV_AUTH_ZONE;
    else process.env.DEV_AUTH_ZONE = original;
    await app.close();
  });

  async function loginZone(email: string): Promise<number | null> {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return decodeJwtPayload(res.body.accessToken as string).zone_id as number | null;
  }

  it('keeps the static dev zone (zoneId=1) when DEV_AUTH_ZONE is unset', async () => {
    delete process.env.DEV_AUTH_ZONE;
    expect(await loginZone('zm.north@fsm.test')).toBe(1);
  });

  it('adopts a live seeded zone by name (any dataset, no code change)', async () => {
    const name = `DZ ${randomUUID().slice(0, 8)}`;
    const zone = await prisma.zone.create({ data: { name } });
    process.env.DEV_AUTH_ZONE = name;
    try {
      expect(await loginZone('zm.north@fsm.test')).toBe(Number(zone.zoneId));
    } finally {
      await prisma.zone.delete({ where: { zoneId: zone.zoneId } });
    }
  });

  it('resolves "first" to the lowest-id seeded zone', async () => {
    const first = await prisma.zone.findFirst({ orderBy: { zoneId: 'asc' } });
    expect(first).not.toBeNull();
    process.env.DEV_AUTH_ZONE = 'first';
    expect(await loginZone('zm.north@fsm.test')).toBe(Number(first!.zoneId));
  });

  it('never rewrites a fleet-wide role (zone_id stays null)', async () => {
    process.env.DEV_AUTH_ZONE = 'first';
    expect(await loginZone('ops.head@fsm.test')).toBeNull();
  });

  it('falls back to the static zone when the configured value resolves to nothing', async () => {
    process.env.DEV_AUTH_ZONE = `__no-such-zone-${randomUUID()}`;
    expect(await loginZone('zm.north@fsm.test')).toBe(1);
  });
});
