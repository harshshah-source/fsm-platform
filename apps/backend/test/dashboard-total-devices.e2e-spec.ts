import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 2 — the `inactive / total` denominator. `zone-overview` and `company-plant-overview` must report
 * `operationalDevices` (non-departed device_states for the entity) beside `inactiveOperational`, so the UI
 * renders a ratio over ONE population. Reworked 2026-07-29 (#176): the denominator used to include
 * warehouse devices while the numerator never did. The inactive counts and byBucket breakdown are unchanged.
 */
describe('Issue 2 — /api/dashboard operational denominator', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let zoneId: bigint;
  let plantId: bigint;
  let companyId: bigint;
  // 3 inactive (bucketed) + 2 ACTIVE (null bucket) = 5 total at one plant/company.
  const deviceIds = [9_062_101n, 9_062_102n, 9_062_103n, 9_062_104n, 9_062_105n].map(String);

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  };

  const seedState = (deviceId: string, bucket: string | null) =>
    prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: bucket !== null,
        inactivityHours: bucket !== null ? 30 : 1,
        slaBucket: bucket as never,
        eligibleForUptime: true,
        plantId,
        companyId,
        computedAt: new Date(),
      },
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    const zone = await prisma.zone.create({ data: { name: 'Z-total-' + Date.now() } });
    zoneId = zone.zoneId;
    const plant = await prisma.plant.create({ data: { name: 'P-total', zoneId } });
    plantId = plant.plantId;
    const company = await prisma.company.create({
      data: { name: 'C-total-' + Date.now(), companyTier: 'GOLD', companyPriorityRank: 'Z9' },
    });
    companyId = company.companyId;

    for (const id of deviceIds) await prisma.device.create({ data: { deviceId: id } });
    await seedState(deviceIds[0], 'CRITICAL');
    await seedState(deviceIds[1], 'SEVERE');
    await seedState(deviceIds[2], 'HIGH_CRITICAL');
    await seedState(deviceIds[3], null); // ACTIVE
    await seedState(deviceIds[4], null); // ACTIVE
  });

  afterAll(async () => {
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await app.close();
  });

  it('zone-overview reports operationalDevices beside inactiveOperational', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/dashboard/zone-overview')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const row = (
      res.body as Array<{ zoneId: string; inactiveOperational: number; operationalDevices: number; healthyOperational: number }>
    ).find((r) => r.zoneId === zoneId.toString());
    expect(row).toBeDefined();
    expect(row!.inactiveOperational).toBe(3);
    expect(row!.operationalDevices).toBe(5);
    expect(row!.healthyOperational).toBe(2);
  });

  it('company-plant-overview reports operationalDevices beside inactiveOperational', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/dashboard/company-plant-overview')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const row = (
      res.body as Array<{ plantId: string; inactiveOperational: number; operationalDevices: number; healthyOperational: number }>
    ).find((r) => r.plantId === plantId.toString());
    expect(row).toBeDefined();
    expect(row!.inactiveOperational).toBe(3);
    expect(row!.operationalDevices).toBe(5);
    expect(row!.healthyOperational).toBe(2);
  });
});
