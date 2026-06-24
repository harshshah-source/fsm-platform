import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 06, slice 1 — `/api/dashboard/zone-overview` (AC#2, AC#5, AC#6).
 *
 * Per-zone inactive counts broken down by SLA bucket, aggregated inline over `device_states`.
 *  - ZM sees only their own zone; CSM/OpsHead see all zones.
 *  - ACTIVE devices (null `sla_bucket`) are never counted.
 *  - trend % vs previous day is null for now (daily-history table is Issue 40).
 */
const ZM_ZONE = 1; // zm.north@fsm.test is zone 1

describe('Issue 06 slice 1 — /api/dashboard/zone-overview', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let otherZoneId: bigint;
  let zmPlantId: bigint;
  let otherPlantId: bigint;
  const deviceIds: bigint[] = [9_061_001n, 9_061_002n, 9_061_003n];

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  };

  const seedState = (deviceId: bigint, plantId: bigint, bucket: string | null) =>
    prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: bucket !== null,
        inactivityHours: bucket !== null ? 30 : 1,
        slaBucket: bucket as never,
        eligibleForUptime: true,
        plantId,
        computedAt: new Date(),
      },
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    const other = await prisma.zone.create({ data: { name: 'Z-dash1-' + Date.now() } });
    otherZoneId = other.zoneId;
    const zmPlant = await prisma.plant.create({ data: { name: 'P-zm', zoneId: BigInt(ZM_ZONE) } });
    zmPlantId = zmPlant.plantId;
    const otherPlant = await prisma.plant.create({ data: { name: 'P-other', zoneId: otherZoneId } });
    otherPlantId = otherPlant.plantId;

    for (const id of deviceIds) await prisma.device.create({ data: { deviceId: id } });
    await seedState(deviceIds[0], zmPlantId, 'HIGH_CRITICAL'); // ZM zone, inactive
    await seedState(deviceIds[1], zmPlantId, null); // ZM zone, ACTIVE — must not count
    await seedState(deviceIds[2], otherPlantId, 'CRITICAL'); // other zone, inactive
  });

  afterAll(async () => {
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [zmPlantId, otherPlantId] } } });
    await prisma.zone.deleteMany({ where: { zoneId: otherZoneId } });
    await app.close();
  });

  it('gives Operations Head all zones with per-bucket counts', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/dashboard/zone-overview')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const rows = res.body as Array<{
      zoneId: string;
      totalInactive: number;
      byBucket: Record<string, number>;
      trendPctVsPrevDay: number | null;
    }>;
    const otherRow = rows.find((r) => r.zoneId === otherZoneId.toString());
    expect(otherRow).toBeDefined();
    expect(otherRow!.byBucket.CRITICAL).toBeGreaterThanOrEqual(1);
    expect(otherRow!.trendPctVsPrevDay).toBeNull();
    expect(rows.some((r) => r.zoneId === String(ZM_ZONE))).toBe(true);
  });

  it('scopes a Zonal Manager to their own zone only', async () => {
    const token = await login('zm.north@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/dashboard/zone-overview')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const rows = res.body as Array<{ zoneId: string; byBucket: Record<string, number> }>;
    expect(rows.every((r) => r.zoneId === String(ZM_ZONE))).toBe(true);
    expect(rows.some((r) => r.zoneId === otherZoneId.toString())).toBe(false);
    const zmRow = rows.find((r) => r.zoneId === String(ZM_ZONE));
    expect(zmRow!.byBucket.HIGH_CRITICAL).toBeGreaterThanOrEqual(1);
    // ACTIVE device contributes no bucket key.
    expect(zmRow!.byBucket.null).toBeUndefined();
  });

  it('forbids a Service Engineer', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .get('/api/dashboard/zone-overview')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('requires authentication', async () => {
    await request(app.getHttpServer()).get('/api/dashboard/zone-overview').expect(401);
  });
});
