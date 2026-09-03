import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { SoftInactiveCountService } from '../src/reports/soft-inactive-count.service';

/**
 * Issue 136 slice 1 — `GET /api/dashboard/operating-mode`.
 *
 * Read-only legibility of the recommender's per-zone operating mode (the same DEFICIT/PREVENTIVE
 * signal `SoftInactiveCountService.modeForZone` feeds the recommender). ZM clamped to their own zone;
 * CSM/OpsHead see all zones. The endpoint returns the internal enum (`mode`) plus the supporting
 * counts; the plain-language mapping ("Catch-up"/"Steady") is a Slice-2 FE concern.
 */
const ZM_ZONE = 1; // zm.north@fsm.test is zone 1

interface ModeRow {
  zoneId: string;
  zoneName: string;
  mode: 'DEFICIT' | 'PREVENTIVE';
  silentCount: number;
  eligibleCount: number;
}

describe('Issue 136 slice 1 — /api/dashboard/operating-mode', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let soft: SoftInactiveCountService;

  let deficitZoneId: bigint;
  let preventiveZoneId: bigint;
  let emptyZoneId: bigint;
  const plantIds: bigint[] = [];
  const deviceIds: string[] = [];

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  };

  /** Seed a device_states row: `silent` = eligible AND inactive; otherwise eligible but active. */
  const seedDevice = async (id: string, plantId: bigint, silent: boolean) => {
    deviceIds.push(id);
    await prisma.device.create({ data: { deviceId: id } });
    await prisma.deviceState.create({
      data: {
        deviceId: id,
        isInactive: silent,
        inactivityHours: silent ? 30 : 1,
        slaBucket: (silent ? 'CRITICAL' : null) as never,
        eligibleForUptime: true,
        plantId,
        computedAt: new Date(),
      },
    });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
    soft = app.get(SoftInactiveCountService);

    const stamp = Date.now();
    const deficitZone = await prisma.zone.create({ data: { name: `Z-opmode-deficit-${stamp}` } });
    const preventiveZone = await prisma.zone.create({ data: { name: `Z-opmode-preventive-${stamp}` } });
    const emptyZone = await prisma.zone.create({ data: { name: `Z-opmode-empty-${stamp}` } });
    deficitZoneId = deficitZone.zoneId;
    preventiveZoneId = preventiveZone.zoneId;
    emptyZoneId = emptyZone.zoneId;

    const deficitPlant = await prisma.plant.create({ data: { name: 'P-opmode-def', zoneId: deficitZoneId } });
    const preventivePlant = await prisma.plant.create({ data: { name: 'P-opmode-prev', zoneId: preventiveZoneId } });
    plantIds.push(deficitPlant.plantId, preventivePlant.plantId);

    // Deficit zone: 3 silent eligible devices out of 4 eligible → 3 > 0.02×4 → DEFICIT.
    await seedDevice('9136001', deficitPlant.plantId, true);
    await seedDevice('9136002', deficitPlant.plantId, true);
    await seedDevice('9136003', deficitPlant.plantId, true);
    await seedDevice('9136004', deficitPlant.plantId, false);
    // Preventive zone: 3 eligible, 0 silent → 0 > 0.02×3 is false → PREVENTIVE.
    await seedDevice('9136010', preventivePlant.plantId, false);
    await seedDevice('9136011', preventivePlant.plantId, false);
    await seedDevice('9136012', preventivePlant.plantId, false);
    // Empty zone: no plants, no devices → eligible 0 → PREVENTIVE (no divide-by-zero).
  });

  afterAll(async () => {
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: plantIds } } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: [deficitZoneId, preventiveZoneId, emptyZoneId] } } });
    await app.close();
  });

  it('gives Operations Head every zone with mode + supporting counts', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/dashboard/operating-mode')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const rows = res.body as ModeRow[];

    const def = rows.find((r) => r.zoneId === deficitZoneId.toString());
    expect(def).toBeDefined();
    expect(def!.mode).toBe('DEFICIT');
    expect(def!.silentCount).toBe(3);
    expect(def!.eligibleCount).toBe(4);
    expect(def!.zoneName).toContain('opmode-deficit');

    const prev = rows.find((r) => r.zoneId === preventiveZoneId.toString());
    expect(prev).toBeDefined();
    expect(prev!.mode).toBe('PREVENTIVE');
    expect(prev!.silentCount).toBe(0);
    expect(prev!.eligibleCount).toBe(3);
  });

  /**
   * #351 AC3 — the cross-zone operating-mode table is mounted on the CSM dashboard as well as the
   * Ops Head's. The role was written into the controller's guard from the start but only the Ops
   * Head was ever exercised here, so "CSM sees all zones" was an assumption the suite did not hold.
   */
  it('gives a Central Service Manager every zone, not just one', async () => {
    const token = await login('csm@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/dashboard/operating-mode')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const rows = res.body as ModeRow[];

    for (const zoneId of [deficitZoneId, preventiveZoneId, emptyZoneId]) {
      expect(rows.some((r) => r.zoneId === zoneId.toString())).toBe(true);
    }
    expect(rows.find((r) => r.zoneId === deficitZoneId.toString())!.mode).toBe('DEFICIT');
  });

  it('resolves a zone with 0 eligible devices to PREVENTIVE without dividing by zero', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/dashboard/operating-mode')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const rows = res.body as ModeRow[];

    const empty = rows.find((r) => r.zoneId === emptyZoneId.toString());
    expect(empty).toBeDefined();
    expect(empty!.eligibleCount).toBe(0);
    expect(empty!.silentCount).toBe(0);
    expect(empty!.mode).toBe('PREVENTIVE');
  });

  it('reports the SAME mode the recommender actually reads (fidelity to modeForZone)', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/dashboard/operating-mode')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const rows = res.body as ModeRow[];

    for (const zoneId of [deficitZoneId, preventiveZoneId, emptyZoneId]) {
      const row = rows.find((r) => r.zoneId === zoneId.toString());
      const engineMode = await soft.modeForZone(zoneId);
      expect(row!.mode).toBe(engineMode);
    }
  });

  it('clamps a Zonal Manager to their own zone, ignoring any zoneId query', async () => {
    const token = await login('zm.north@fsm.test');
    const res = await request(app.getHttpServer())
      .get(`/api/dashboard/operating-mode?zoneId=${deficitZoneId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const rows = res.body as ModeRow[];

    expect(rows.length).toBe(1);
    expect(rows[0].zoneId).toBe(String(ZM_ZONE));
    expect(rows.some((r) => r.zoneId === deficitZoneId.toString())).toBe(false);
  });

  it('forbids a Service Engineer', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .get('/api/dashboard/operating-mode')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('requires authentication', async () => {
    await request(app.getHttpServer()).get('/api/dashboard/operating-mode').expect(401);
  });
});
