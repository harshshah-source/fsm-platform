import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 40 slice 3 — `/api/reports/soft-inactive-*` HTTP surface (AC#3/#4). Operations Head snapshots
 * the per-zone Soft Inactive Count, then reads the twice-daily trend series. Managers/SEs are forbidden
 * (the trend is an Operations-Head view). A spec-unique zone isolates the assertions.
 */
const NS = Date.now();

describe('Issue 40 slice 3 — /api/reports/soft-inactive-* (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let zoneX: bigint;
  let plantX: bigint;
  const devices = [9_402_900n, 9_402_901n];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    zoneX = (await prisma.zone.create({ data: { name: 'Z-sit-' + NS } })).zoneId;
    plantX = (await prisma.plant.create({ data: { name: 'P-sit-' + NS, zoneId: zoneX } })).plantId;
    // 2 eligible devices, 1 inactive → soft=1, eligible=2 → deficit (1 > 0.02×2 = 0.04)
    await prisma.device.create({ data: { deviceId: devices[0], deviceType: 'GPS-X' } });
    await prisma.deviceState.create({ data: { deviceId: devices[0], eligibleForUptime: true, isInactive: true, plantId: plantX, computedAt: new Date() } });
    await prisma.device.create({ data: { deviceId: devices[1], deviceType: 'GPS-X' } });
    await prisma.deviceState.create({ data: { deviceId: devices[1], eligibleForUptime: true, isInactive: false, plantId: plantX, computedAt: new Date() } });
  });

  afterAll(async () => {
    await prisma.softInactiveCountHistory.deleteMany({ where: { zoneId: zoneX } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: devices } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: devices } } });
    await prisma.plant.deleteMany({ where: { plantId: plantX } });
    await prisma.zone.deleteMany({ where: { zoneId: zoneX } });
    await app.close();
  });

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  };

  it('Operations Head recomputes, then the trend shows the zone series', async () => {
    const oh = await login('ops.head@fsm.test');
    const recompute = await request(app.getHttpServer())
      .post('/api/reports/soft-inactive/recompute')
      .set('Authorization', `Bearer ${oh}`)
      .expect(200);
    expect(recompute.body.zones).toBeGreaterThanOrEqual(1);

    const trend = await request(app.getHttpServer())
      .get('/api/reports/soft-inactive-trend?days=7')
      .set('Authorization', `Bearer ${oh}`)
      .expect(200);
    expect(trend.body.sinceDays).toBe(7);
    const mine = trend.body.zones.find((z: { zoneId: string }) => z.zoneId === String(zoneX));
    expect(mine).toBeTruthy();
    const last = mine.points[mine.points.length - 1];
    expect(last.softInactiveCount).toBe(1);
    expect(last.eligibleDeviceCount).toBe(2);
    expect(last.deficitMode).toBe(true);
    expect(['MORNING', 'AFTERNOON']).toContain(last.period);
  });

  it('forbids a ZM and an SE from the Operations-Head trend (403)', async () => {
    const zm = await login('zm.north@fsm.test');
    await request(app.getHttpServer()).get('/api/reports/soft-inactive-trend').set('Authorization', `Bearer ${zm}`).expect(403);
    const se = await login('se.north@fsm.test');
    await request(app.getHttpServer()).get('/api/reports/soft-inactive-trend').set('Authorization', `Bearer ${se}`).expect(403);
  });

  it('forbids a ZM from triggering the recompute (403)', async () => {
    const zm = await login('zm.north@fsm.test');
    await request(app.getHttpServer()).post('/api/reports/soft-inactive/recompute').set('Authorization', `Bearer ${zm}`).expect(403);
  });
});
