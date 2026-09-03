import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 134 — `/api/dashboard/activity-trend`. Three time series (Inactive-device stock vs
 * TROUBLESHOOT vs INSTALL tickets created) bucketed over a range. Seeds an isolated zone so the
 * ticket counts are deterministic in the shared dev DB; asserts pan/zone shaping, the ZM zone-clamp,
 * and range validation.
 */
interface TrendPoint {
  bucket: string;
  inactive: number | null;
  troubleshoot: number;
  installation: number;
}
interface TrendReport {
  range: string;
  bucket: string;
  zoneId: number | null;
  points: TrendPoint[];
}

describe('Issue 134 — /api/dashboard/activity-trend', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let zoneId: bigint;
  let plantId: bigint;
  let companyId: bigint;
  const tsDevices = [9_134_001n, 9_134_002n].map(String); // troubleshoot devices (inactive + eligible)
  const installDevice = '9134003';

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    const zone = await prisma.zone.create({ data: { name: 'Z-trend-' + Date.now() } });
    zoneId = zone.zoneId;
    const plant = await prisma.plant.create({ data: { name: 'P-trend', zoneId } });
    plantId = plant.plantId;
    const company = await prisma.company.create({
      data: { name: 'Co-trend-' + Date.now(), companyTier: 'GOLD', companyPriorityRank: 'B' },
    });
    companyId = company.companyId;

    const now = new Date();
    // Two TROUBLESHOOT tickets (their devices are inactive + eligible → live inactive count = 2).
    for (const deviceId of tsDevices) {
      await prisma.device.create({ data: { deviceId } });
      await prisma.deviceState.create({
        data: {
          deviceId, isInactive: true, inactivityHours: 40, slaBucket: 'CRITICAL' as never,
          eligibleForUptime: true, hasOpenFailureCycle: true, plantId, companyId, computedAt: now,
        },
      });
      const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: now } });
      await prisma.ticket.create({
        data: {
          workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: cycle.cycleId, deviceId, plantId,
          companyId, companyTier: 'GOLD', lastStateChangedAt: now, createdAt: now,
        },
      });
    }
    // One INSTALL ticket; its device is ACTIVE (not counted in the live inactive stock). The status
    // is incidental — the trend query groups on `created_at` + `work_type` and never reads it — so it
    // is the one an install ticket is actually created in (#309: `OPEN` belongs to TROUBLESHOOT, and
    // the `tickets_work_type_status` CHECK now says so).
    await prisma.device.create({ data: { deviceId: installDevice } });
    await prisma.ticket.create({
      data: {
        workType: 'INSTALL', status: 'REQUESTED', deviceId: installDevice, plantId, companyId,
        companyTier: 'GOLD', lastStateChangedAt: now, createdAt: now,
      },
    });

    // A historical inactive snapshot ~26h ago (a previous day-bucket) with a distinct value.
    await prisma.softInactiveCountHistory.create({
      data: {
        zoneId, capturedAt: new Date(now.getTime() - 26 * 60 * 60 * 1000), period: 'AFTERNOON',
        softInactiveCount: 7, eligibleDeviceCount: 10, deficitMode: false, thresholdPct: 0.02,
      },
    });
  });

  afterAll(async () => {
    const deviceIds = [...tsDevices, installDevice];
    await prisma.ticket.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.softInactiveCountHistory.deleteMany({ where: { zoneId } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await app.close();
  });

  it('shapes a zone-wise trend for an Operations Head (deterministic counts in the isolated zone)', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get(`/api/dashboard/activity-trend?range=7D&zoneId=${zoneId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const report = res.body as TrendReport;

    expect(report.zoneId).toBe(Number(zoneId));
    expect(report.bucket).toBe('day');
    expect(Array.isArray(report.points)).toBe(true);
    // Flow series sum to exactly what we seeded in this zone.
    const sum = (k: 'troubleshoot' | 'installation') => report.points.reduce((s, p) => s + p[k], 0);
    expect(sum('troubleshoot')).toBe(2);
    expect(sum('installation')).toBe(1);
    // Inactive stock: the current bucket carries the live count (2); a prior bucket carries the snapshot (7).
    expect(report.points[report.points.length - 1].inactive).toBe(2);
    expect(report.points.some((p) => p.inactive === 7)).toBe(true);
  });

  it('clamps a Zonal Manager to their own zone regardless of the requested zoneId', async () => {
    const token = await login('zm.north@fsm.test'); // zone 1
    const res = await request(app.getHttpServer())
      .get(`/api/dashboard/activity-trend?range=7D&zoneId=${zoneId}`) // asks for the isolated zone
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const report = res.body as TrendReport;
    // Clamped to zone 1 — the requested foreign zone is ignored, so the isolated-zone install is absent.
    expect(report.zoneId).toBe(1);
  });

  it('serves pan-India when no zoneId is given (Operations Head)', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/dashboard/activity-trend?range=1M')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const report = res.body as TrendReport;
    expect(report.zoneId).toBeNull();
    expect(report.bucket).toBe('day');
  });

  it('rejects an invalid range with 400', async () => {
    const token = await login('ops.head@fsm.test');
    await request(app.getHttpServer())
      .get('/api/dashboard/activity-trend?range=5Y')
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
  });

  it('forbids a Service Engineer and requires auth', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .get('/api/dashboard/activity-trend?range=7D')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    await request(app.getHttpServer()).get('/api/dashboard/activity-trend?range=7D').expect(401);
  });
});
