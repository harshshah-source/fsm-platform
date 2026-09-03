import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { Prisma } from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 06, slice 1 — `/api/dashboard/zone-overview` (AC#2, AC#5, AC#6).
 *
 * Per-zone inactive counts broken down by SLA bucket, aggregated inline over `device_states`.
 *  - ZM sees only their own zone; CSM/OpsHead see all zones.
 *  - ACTIVE devices (null `sla_bucket`) are never counted.
 *
 * #351 — `trendPctVsPrevDay` is no longer a hardcoded `null`. It is the signed percentage change of
 * the zone's Soft Inactive Count between its two most recent `soft_inactive_count_history` captures
 * (the table has existed since Issue 40; nothing ever read it here). The cases below pin the three
 * states that matter: a real signed movement, a zone with only one capture, and a zero baseline —
 * because "no reading yet" and "0% change" must never render the same way.
 */
const ZM_ZONE = 1; // zm.north@fsm.test is zone 1

interface OverviewRow {
  zoneId: string;
  inactiveOperational: number;
  byBucket: Record<string, number>;
  trendPctVsPrevDay: number | null;
}

describe('Issue 06 slice 1 — /api/dashboard/zone-overview', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let otherZoneId: bigint;
  let singleCaptureZoneId: bigint;
  let zeroBaselineZoneId: bigint;
  let zmPlantId: bigint;
  let otherPlantId: bigint;
  const plantIds: bigint[] = [];
  const deviceIds: string[] = [9_061_001n, 9_061_002n, 9_061_003n, 9_061_004n, 9_061_005n].map(String);

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  };

  const seedState = (deviceId: string, plantId: bigint, bucket: string | null) =>
    prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: bucket !== null,
        inactivityHours: bucket !== null ? 30 : 1,
        slaBucket: bucket as never,
        eligibleForUptime: true,
        // #223 — a device with no `latestGpsDatetime` is now NEVER-REPORTED, not healthy, so it is in
        // neither the healthy nor the inactive count and contributes no SLA bucket. This fixture meant
        // "reporting devices, some of them silent", which now has to be said rather than assumed.
        latestGpsDatetime: new Date('2026-08-07T09:58:34.000Z'),
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

    const stamp = Date.now();
    const other = await prisma.zone.create({ data: { name: 'Z-dash1-' + stamp } });
    otherZoneId = other.zoneId;
    const singleCapture = await prisma.zone.create({ data: { name: 'Z-dash1-single-' + stamp } });
    singleCaptureZoneId = singleCapture.zoneId;
    const zeroBaseline = await prisma.zone.create({ data: { name: 'Z-dash1-zero-' + stamp } });
    zeroBaselineZoneId = zeroBaseline.zoneId;

    const zmPlant = await prisma.plant.create({ data: { name: 'P-zm', zoneId: BigInt(ZM_ZONE) } });
    zmPlantId = zmPlant.plantId;
    const otherPlant = await prisma.plant.create({ data: { name: 'P-other', zoneId: otherZoneId } });
    otherPlantId = otherPlant.plantId;
    const singlePlant = await prisma.plant.create({ data: { name: 'P-single', zoneId: singleCaptureZoneId } });
    const zeroPlant = await prisma.plant.create({ data: { name: 'P-zero', zoneId: zeroBaselineZoneId } });
    plantIds.push(zmPlantId, otherPlantId, singlePlant.plantId, zeroPlant.plantId);

    for (const id of deviceIds) await prisma.device.create({ data: { deviceId: id } });
    await seedState(deviceIds[0], zmPlantId, 'HIGH_CRITICAL'); // ZM zone, inactive
    await seedState(deviceIds[1], zmPlantId, null); // ZM zone, ACTIVE — must not count
    await seedState(deviceIds[2], otherPlantId, 'CRITICAL'); // other zone, inactive
    // A zone only appears in the overview if it has at least one mirrored device (rows are driven by
    // the counts query), so the two trend-only zones each need one.
    await seedState(deviceIds[3], singlePlant.plantId, 'CRITICAL');
    await seedState(deviceIds[4], zeroPlant.plantId, 'CRITICAL');

    // #351 — the Soft Inactive Count captures the trend is computed from. Written directly rather
    // than through `SoftInactiveCountService.recompute`, which snapshots EVERY zone at one instant:
    // these three zones need different capture histories from each other in the same run.
    const capture = (zoneId: bigint, minutesAgo: number, count: number) => ({
      zoneId,
      capturedAt: new Date(Date.now() - minutesAgo * 60_000),
      period: minutesAgo > 720 ? 'MORNING' : 'AFTERNOON',
      softInactiveCount: count,
      eligibleDeviceCount: 100,
      deficitMode: false,
      thresholdPct: new Prisma.Decimal(0.02),
    });
    await prisma.softInactiveCountHistory.createMany({
      data: [
        capture(otherZoneId, 1_440, 10), // previous capture
        capture(otherZoneId, 60, 13), // latest capture → +30.0%
        capture(singleCaptureZoneId, 60, 7), // only one capture on record
        capture(zeroBaselineZoneId, 1_440, 0), // baseline of zero
        capture(zeroBaselineZoneId, 60, 5),
      ],
    });
  });

  afterAll(async () => {
    await prisma.softInactiveCountHistory.deleteMany({
      where: { zoneId: { in: [otherZoneId, singleCaptureZoneId, zeroBaselineZoneId] } },
    });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: plantIds } } });
    await prisma.zone.deleteMany({
      where: { zoneId: { in: [otherZoneId, singleCaptureZoneId, zeroBaselineZoneId] } },
    });
    await app.close();
  });

  it('gives Operations Head all zones with per-bucket counts', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/dashboard/zone-overview')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const rows = res.body as OverviewRow[];
    const otherRow = rows.find((r) => r.zoneId === otherZoneId.toString());
    expect(otherRow).toBeDefined();
    expect(otherRow!.byBucket.CRITICAL).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.zoneId === String(ZM_ZONE))).toBe(true);
  });

  // ---- #351 AC2 — the trend column ------------------------------------------------------------

  it('reports a signed % change between the two most recent Soft Inactive Count captures', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/dashboard/zone-overview')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const row = (res.body as OverviewRow[]).find((r) => r.zoneId === otherZoneId.toString());
    // 10 → 13 is +30%. Signed, so a rise reads as a rise: this column is about direction first.
    expect(row!.trendPctVsPrevDay).toBe(30);
  });

  it('leaves the trend null when the zone has only one capture on record', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/dashboard/zone-overview')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const row = (res.body as OverviewRow[]).find((r) => r.zoneId === singleCaptureZoneId.toString());
    expect(row).toBeDefined();
    expect(row!.trendPctVsPrevDay).toBeNull();
  });

  it('leaves the trend null rather than dividing by a zero baseline', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/dashboard/zone-overview')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const row = (res.body as OverviewRow[]).find((r) => r.zoneId === zeroBaselineZoneId.toString());
    expect(row).toBeDefined();
    // 0 → 5 has no percentage. Reporting "+Infinity%" or "+500%" would both be inventions.
    expect(row!.trendPctVsPrevDay).toBeNull();
  });

  it('gives a Zonal Manager the trend for their own zone', async () => {
    const token = await login('zm.north@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/dashboard/zone-overview')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const rows = res.body as OverviewRow[];
    expect(rows).toHaveLength(1);
    // Whatever zone 1's own history holds, the field must be a number or null — never absent.
    expect(rows[0]).toHaveProperty('trendPctVsPrevDay');
    expect(rows[0].trendPctVsPrevDay === null || typeof rows[0].trendPctVsPrevDay === 'number').toBe(true);
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
