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
const DEV = String(9_393_900n);
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
    // #223 P3 — `latestGpsDatetime` is now part of uptime eligibility: a device that has NEVER reported
    // is excluded from the Fleet Uptime denominator rather than scored 100% for a month it spent dark.
    // This fixture's device reported and then had a closed failure cycle, so it must carry a timestamp.
    await prisma.deviceState.create({
      data: {
        deviceId: DEV,
        eligibleForUptime: true,
        latestGpsDatetime: new Date(Date.UTC(2026, 4, 12)),
        plantId,
        companyId,
        computedAt: new Date(),
      },
    });
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

  /**
   * #346 AC4 — the empty month over HTTP, which is the shape the admin Reports page actually gets.
   * The page defaults to the CURRENT month (`reports.controller.ts` `currentMonth()`) while the cube
   * cron only ever wrote the previous one, so "a month with no cube row" was the default view, and it
   * answered `100`. `2029-10` is a month nothing in the tree computes; the assertion is that the wire
   * payload carries `null`, not a number and not a missing key.
   */
  it('a month with no cube row returns uptimePct null over the wire, never 100', async () => {
    const oh = await login('ops.head@fsm.test');
    const report = await request(app.getHttpServer())
      .get('/api/reports/fleet-uptime?month=2029-10&groupBy=zone')
      .set('Authorization', `Bearer ${oh}`)
      .expect(200);
    expect(report.body.fleet).toHaveProperty('uptimePct');
    expect(report.body.fleet.uptimePct).toBeNull();
    expect(report.body.fleet.eligibleDeviceCount).toBe(0);
    expect(report.body.rows).toEqual([]);
  });

  /** #346 AC5 — the manual recompute door is untouched by the honesty change. */
  it('the Operations-Head recompute endpoint is unchanged (200, month + device count)', async () => {
    const oh = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .post('/api/reports/fleet-uptime/recompute?month=2026-05')
      .set('Authorization', `Bearer ${oh}`)
      .expect(200);
    expect(res.body.month).toBe('2026-05-01');
    expect(typeof res.body.devices).toBe('number');
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
