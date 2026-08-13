import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Device list read (`GET /api/devices`) — the FE-22 gap. Manager read, zone-scoped (ZM own-zone,
 * CSM/OH all), searchable; driven from `device_states` joined to vehicle / plant / zone / company.
 */
const NS = Date.now();

describe('Device list (FE-22 backend, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let vehicleId: bigint;
  const deviceId = String(11_900_000_000 + (NS % 100_000));
  /** #235 — a SECOND device at the same plant, fitted long ago, so the filter has something to exclude. */
  const oldDeviceId = String(11_910_000_000 + (NS % 100_000));
  const daysAgo = (d: number): Date => new Date(Date.now() - d * 24 * 3_600_000);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-dl-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Acme-dl-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'Plant-dl-' + NS, zoneId } })).plantId;
    vehicleId = (await prisma.vehicle.create({ data: { vehicleNo: 'DL-VEH-' + NS, plantId, companyId } })).vehicleId;
    await prisma.device.create({ data: { deviceId, currentVehicleId: vehicleId, deviceType: 'AIS-140' } });
    await prisma.deviceState.create({
      data: {
        deviceId, vehicleId, plantId, companyId,
        isInactive: true, slaBucket: 'CRITICAL', latestGpsDatetime: new Date(NS - 40 * 3600 * 1000), computedAt: new Date(),
      },
    });

    // #235 fixtures. The recent device carries TWO fitments inside the window — the re-map case — so
    // the EXISTS is proven to keep device grain rather than fanning the row out.
    await prisma.device.create({ data: { deviceId: oldDeviceId, deviceType: 'AIS-140' } });
    await prisma.deviceState.create({
      // Deliberately no vehicle: the pre-existing specs search on this plant's vehicle_no and assert
      // a total of 1, so a second device sharing that vehicle would break them. Same plant, so the
      // #235 assertions below can still scope by plantId.
      data: { deviceId: oldDeviceId, plantId, companyId, computedAt: new Date() },
    });
    await prisma.deviceCommissioning.createMany({
      data: [
        { deviceId, vehicleId, plantId, companyId, installedAt: daysAgo(3), installedAtOffsetMin: 0 },
        { deviceId, vehicleId: null, plantId, companyId, installedAt: daysAgo(10), installedAtOffsetMin: 0 },
        { deviceId: oldDeviceId, vehicleId: null, plantId, companyId, installedAt: daysAgo(200), installedAtOffsetMin: 0 },
      ],
    });
  });

  afterAll(async () => {
    await prisma.deviceCommissioning.deleteMany({ where: { deviceId: { in: [deviceId, oldDeviceId] } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: [deviceId, oldDeviceId] } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: [deviceId, oldDeviceId] } } });
    await prisma.vehicle.deleteMany({ where: { vehicleId } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await app.close();
  });

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  }

  type ListBody = {
    total: number;
    rows: { deviceId: string; vehicleNo: string; plantName: string; zoneName: string; slaBucket: string; latestGpsDatetime: string | null }[];
  };

  it('lists the device with vehicle / plant / zone / bucket for a manager (Operations Head)', async () => {
    const token = await login('ops.head@fsm.test');
    // Scope by search so the assertion is deterministic regardless of how many devices the DB holds.
    const res = await request(app.getHttpServer())
      .get(`/api/devices?search=DL-VEH-${NS}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const body = res.body as ListBody;
    const row = body.rows.find((r) => r.deviceId === String(deviceId));
    expect(row).toBeDefined();
    expect(row!.vehicleNo).toBe('DL-VEH-' + NS);
    expect(row!.plantName).toBe('Plant-dl-' + NS);
    expect(row!.zoneName).toBe('Z-dl-' + NS);
    expect(row!.slaBucket).toBe('CRITICAL');
    // Issue 3 — the elapsed-inactivity duration source is exposed to the UI.
    expect(row!.latestGpsDatetime).toBe(new Date(NS - 40 * 3600 * 1000).toISOString());
    // Paged response — the search matches exactly the one seeded device.
    expect(body.total).toBe(1);
  });

  it('filters by search term', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer()).get(`/api/devices?search=DL-VEH-${NS}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect((res.body as ListBody).rows.some((r) => r.deviceId === String(deviceId))).toBe(true);

    const miss = await request(app.getHttpServer()).get('/api/devices?search=__no-such-thing__').set('Authorization', `Bearer ${token}`).expect(200);
    const missBody = miss.body as ListBody;
    expect(missBody.rows.some((r) => r.deviceId === String(deviceId))).toBe(false);
    expect(missBody.total).toBe(0);
  });

  it('pages with limit/offset and reports the full filtered total', async () => {
    const token = await login('ops.head@fsm.test');
    // limit=1 returns a single row but total counts the whole (unpaged) filtered set.
    const res = await request(app.getHttpServer())
      .get('/api/devices?limit=1&offset=0')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const body = res.body as ListBody;
    expect(body.rows).toHaveLength(1);
    expect(body.total).toBeGreaterThanOrEqual(1);
  });

  it('excludes a device outside the ZM zone', async () => {
    const token = await login('zm.north@fsm.test'); // dev ZM = zone 1, not the seeded zone
    const res = await request(app.getHttpServer()).get('/api/devices').set('Authorization', `Bearer ${token}`).expect(200);
    expect((res.body as ListBody).rows.some((r) => r.deviceId === String(deviceId))).toBe(false);
  });

  it('forbids a Service Engineer (manager-only read)', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer()).get('/api/devices').set('Authorization', `Bearer ${token}`).expect(403);
  });

  it('filters by status and SLA bucket', async () => {
    const token = await login('ops.head@fsm.test');
    const q = `search=DL-VEH-${NS}`;
    const has = async (extra: string) => {
      const res = await request(app.getHttpServer()).get(`/api/devices?${q}&${extra}`).set('Authorization', `Bearer ${token}`).expect(200);
      return (res.body as ListBody).rows.some((r) => r.deviceId === String(deviceId));
    };
    // The seeded device is INACTIVE / CRITICAL.
    expect(await has('status=INACTIVE')).toBe(true);
    expect(await has('status=ACTIVE')).toBe(false);
    expect(await has('bucket=CRITICAL')).toBe(true);
    expect(await has('bucket=WARNING')).toBe(false);
  });

  it('accepts every sort key (whitelisted) and returns the seeded device', async () => {
    const token = await login('ops.head@fsm.test');
    for (const sort of ['LONGEST_INACTIVE', 'NEWEST_ACTIVITY', 'SLA_SEVERITY', 'DEVICE_ID', 'PRIORITY']) {
      const res = await request(app.getHttpServer())
        .get(`/api/devices?search=DL-VEH-${NS}&sort=${sort}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect((res.body as ListBody).rows.some((r) => r.deviceId === String(deviceId))).toBe(true);
    }
  });

  it('filter-options lists the zones and companies present in scope', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer()).get('/api/devices/filter-options').set('Authorization', `Bearer ${token}`).expect(200);
    const body = res.body as { zones: { name: string }[]; companies: { name: string }[]; hasUnzoned: boolean };
    expect(body.zones.some((z) => z.name === 'Z-dl-' + NS)).toBe(true);
    expect(body.companies.some((c) => c.name === 'Acme-dl-' + NS)).toBe(true);
    expect(typeof body.hasUnzoned).toBe('boolean');
  });

  it('forbids filter-options for a Service Engineer', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer()).get('/api/devices/filter-options').set('Authorization', `Bearer ${token}`).expect(403);
  });

  // -----------------------------------------------------------------------------------------------
  // #235 — the commissioning drill-through filter.
  //
  // Entered by clicking a row on the #232 cohort page, which is why the window predicate is IMPORTED
  // from `reports/commissioning-window.ts` rather than spelled again here: two spellings of "recent"
  // would show a reader two different answers to the question they just clicked on.
  // -----------------------------------------------------------------------------------------------
  describe('commissionedWithinDays (#235)', () => {
    const list = async (query: string, expected = 200) => {
      const token = await login('ops.head@fsm.test');
      return request(app.getHttpServer()).get(`/api/devices?${query}`).set('Authorization', `Bearer ${token}`).expect(expected);
    };

    it('is absent by default — both devices are returned, exactly as before the filter existed', async () => {
      // The regression floor. This endpoint backs a live page, so an unrequested filter must change
      // nothing at all.
      const res = await list(`plantId=${plantId}`);
      const ids = (res.body as ListBody).rows.map((r) => r.deviceId);
      expect(ids).toContain(deviceId);
      expect(ids).toContain(oldDeviceId);
    });

    it('keeps a device fitted inside the window and drops one fitted 200 days ago', async () => {
      const res = await list(`plantId=${plantId}&commissionedWithinDays=90`);
      const ids = (res.body as ListBody).rows.map((r) => r.deviceId);
      expect(ids).toContain(deviceId);
      expect(ids).not.toContain(oldDeviceId);
    });

    it('returns ONE row for a device with two fitments in the window — device grain, not fitment grain', async () => {
      // The cohort page counts that same device as two fitments. Both numbers are right; this is the
      // 6.4% divergence both surfaces have to label rather than reconcile away.
      const res = await list(`plantId=${plantId}&commissionedWithinDays=90`);
      const rows = (res.body as ListBody).rows.filter((r) => r.deviceId === deviceId);
      expect(rows).toHaveLength(1);
      expect((res.body as ListBody).total).toBe(1);
    });

    it('narrows with the window, so the parameter is genuinely bound and not ignored', async () => {
      // 5 days reaches the 3-day fitment; 2 days reaches neither. A filter that silently no-oped would
      // pass every assertion above.
      expect((await list(`plantId=${plantId}&commissionedWithinDays=5`)).body.total).toBe(1);
      expect((await list(`plantId=${plantId}&commissionedWithinDays=2`)).body.total).toBe(0);
    });

    it('rejects a window past the cohort ceiling rather than clamping it silently', async () => {
      // Same ceiling as `/reports/commissioning/cohort`. Answering a 200-day question with 90 days of
      // data would let the two surfaces disagree while both looked fine.
      await list(`commissionedWithinDays=200`, 400);
      await list(`commissionedWithinDays=0`, 400);
      await list(`commissionedWithinDays=abc`, 400);
    });

    it('holds the ZM zone clamp through the new filter', async () => {
      // The fixture plant is in its own zone, so zm.north (zone 1) must not see it however the filter
      // is set. Proven, not assumed — a new WHERE fragment is exactly where a clamp gets lost.
      const token = await login('zm.north@fsm.test');
      const res = await request(app.getHttpServer())
        .get(`/api/devices?commissionedWithinDays=90&search=DL-VEH-${NS}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect((res.body as ListBody).rows.map((r) => r.deviceId)).not.toContain(deviceId);
    });
  });
});
