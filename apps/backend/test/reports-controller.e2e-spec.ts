import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 39 slice 3 — `/api/reports/fleet-uptime` HTTP surface. Operations Head recomputes a month, then
 * the report reads it: grouped per zone/company/plant, eligible-only, ZM zone-scoped. A grouping by the
 * spec's own (unique) plant isolates exact numbers. Seeded: `zm.north` (ZM zone 1), `ops.head`,
 * `se.north`. May 2026 is a completed month so the window is the full month (31 days).
 */
const DEV = 9_393_900n;
const MAY_SECONDS = 31 * 86_400;
const DOWNTIME = 2 * 86_400; // a 2-day May outage
const EXPECTED_UPTIME = Math.round((1 - DOWNTIME / MAY_SECONDS) * 100 * 100) / 100; // 93.55

describe('Issue 39 slice 3 — /api/reports/fleet-uptime (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let zone1: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let cycleId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    const stamp = Date.now();
    zone1 = (await prisma.zone.upsert({ where: { zoneId: 1n }, update: {}, create: { zoneId: 1n, name: 'Zone-1-seed' } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-rep-' + stamp, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-rep-' + stamp, zoneId: zone1 } })).plantId;
    await prisma.device.create({ data: { deviceId: DEV, deviceType: 'GPS-X' } });
    await prisma.deviceState.create({ data: { deviceId: DEV, eligibleForUptime: true, plantId, companyId, computedAt: new Date() } });
    cycleId = randomUUID();
    await prisma.failureCycle.create({
      data: { cycleId, deviceId: DEV, state: 'VERIFIED', openedAt: new Date(Date.UTC(2026, 4, 10)), closedAt: new Date(Date.UTC(2026, 4, 12)) },
    });
  });

  afterAll(async () => {
    await prisma.deviceDowntimeSummaryMonthly.deleteMany({ where: { deviceId: DEV } });
    await prisma.failureCycle.deleteMany({ where: { cycleId } });
    await prisma.deviceState.deleteMany({ where: { deviceId: DEV } });
    await prisma.device.deleteMany({ where: { deviceId: DEV } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await app.close();
  });

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  };

  it('Operations Head recomputes May, then the per-plant report shows the exact uptime', async () => {
    const oh = await login('ops.head@fsm.test');
    const recompute = await request(app.getHttpServer())
      .post('/api/reports/fleet-uptime/recompute?month=2026-05')
      .set('Authorization', `Bearer ${oh}`)
      .expect(200);
    expect(recompute.body.month).toBe('2026-05-01');
    expect(recompute.body.devices).toBeGreaterThanOrEqual(1);

    const report = await request(app.getHttpServer())
      .get('/api/reports/fleet-uptime?month=2026-05&groupBy=plant')
      .set('Authorization', `Bearer ${oh}`)
      .expect(200);
    const mine = report.body.rows.find((r: { id: string }) => r.id === String(plantId));
    expect(mine.eligibleDeviceCount).toBe(1);
    expect(mine.uptimePct).toBe(EXPECTED_UPTIME);
  });

  it('a ZM sees only their own zone (zone 1)', async () => {
    const zm = await login('zm.north@fsm.test');
    const report = await request(app.getHttpServer())
      .get('/api/reports/fleet-uptime?month=2026-05&groupBy=zone')
      .set('Authorization', `Bearer ${zm}`)
      .expect(200);
    expect(report.body.rows.every((r: { id: string }) => r.id === '1')).toBe(true);
    expect(report.body.rows.find((r: { id: string }) => r.id === '1')).toBeTruthy();
  });

  it('forbids a Service Engineer (403)', async () => {
    const se = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .get('/api/reports/fleet-uptime?month=2026-05')
      .set('Authorization', `Bearer ${se}`)
      .expect(403);
  });

  it('forbids a ZM from triggering recompute — Operations Head only (403)', async () => {
    const zm = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/reports/fleet-uptime/recompute?month=2026-05')
      .set('Authorization', `Bearer ${zm}`)
      .expect(403);
  });

  it('rejects an invalid groupBy and an invalid month (400)', async () => {
    const oh = await login('ops.head@fsm.test');
    await request(app.getHttpServer())
      .get('/api/reports/fleet-uptime?month=2026-05&groupBy=bogus')
      .set('Authorization', `Bearer ${oh}`)
      .expect(400);
    await request(app.getHttpServer())
      .get('/api/reports/fleet-uptime?month=2026-13&groupBy=zone')
      .set('Authorization', `Bearer ${oh}`)
      .expect(400);
  });
});
