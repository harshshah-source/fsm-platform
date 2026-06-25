import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 49 slice 2 — the device `deal_type` HTTP surface (`/api/devices`). The manual tag is
 * Operations-Head-only (others 403); bad enum / id is 400; unknown device is 404. The manager read
 * path exposes `deal_type` for #35. Tag behaviour + audit are proven in device-deal-type-service.
 */
const NS = Date.now();

describe('/api/devices deal_type (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let deviceId: bigint;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
    deviceId = BigInt(12_100_000_000 + (NS % 100_000));
    await prisma.device.create({ data: { deviceId } });
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { entityType: 'device', entityId: String(deviceId) } });
    await prisma.device.deleteMany({ where: { deviceId } });
    await app.close();
  });

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  };

  it('Operations Head tags deal_type (200) and the read path returns it', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .patch(`/api/devices/${deviceId}/deal-type`)
      .set('Authorization', `Bearer ${token}`)
      .send({ dealType: 'RECURRING' })
      .expect(200);
    expect(res.body.dealType).toBe('RECURRING');

    const read = await request(app.getHttpServer()).get(`/api/devices/${deviceId}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(read.body.dealType).toBe('RECURRING');
  });

  it('forbids a Zonal Manager and an SE from tagging (403)', async () => {
    for (const email of ['zm.north@fsm.test', 'se.north@fsm.test']) {
      const token = await login(email);
      await request(app.getHttpServer())
        .patch(`/api/devices/${deviceId}/deal-type`)
        .set('Authorization', `Bearer ${token}`)
        .send({ dealType: 'ONE_TIME' })
        .expect(403);
    }
  });

  it('rejects a bad deal_type (400) and an unknown device (404)', async () => {
    const token = await login('ops.head@fsm.test');
    await request(app.getHttpServer())
      .patch(`/api/devices/${deviceId}/deal-type`)
      .set('Authorization', `Bearer ${token}`)
      .send({ dealType: 'LEASE' })
      .expect(400);
    await request(app.getHttpServer())
      .patch(`/api/devices/99999999999/deal-type`)
      .set('Authorization', `Bearer ${token}`)
      .send({ dealType: 'RECURRING' })
      .expect(404);
  });

  it('rejects an unauthenticated tag (401)', async () => {
    await request(app.getHttpServer()).patch(`/api/devices/${deviceId}/deal-type`).send({ dealType: 'RECURRING' }).expect(401);
  });
});
