import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 27 — acting as ZM has to move the DATA, not just the audit attribution.
 *
 * `X-Acting-As-Zone` already produced `acted_as_role` on audited writes
 * (`request-actor-attribution.e2e-spec.ts`), but every `/api/dashboard/*` read built its scope from the
 * raw claims — so an Operations Head acting in a zone kept receiving pan-India aggregations while the
 * admin UI rendered them under the Zone Operations Dashboard. These assert the read scope collapses to
 * the acted-in zone, and that the header still cannot widen a ZM.
 */
const ZM_ZONE = 1; // zm.north@fsm.test is zone 1

describe('Issue 27 — acting-as-ZM scopes the dashboard reads', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let otherZoneId: bigint;
  let zmPlantId: bigint;
  let otherPlantId: bigint;
  /** #339 — the open ZM window that makes the CSM's acting request permissible at all. */
  let zmOutWindowId: bigint;
  const deviceIds: string[] = [9_270_001n, 9_270_002n].map(String);

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  };

  const seedState = (deviceId: string, plantId: bigint) =>
    prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        inactivityHours: 30,
        slaBucket: 'CRITICAL' as never,
        eligibleForUptime: true,
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

    const other = await prisma.zone.create({ data: { name: 'Z-acting-' + Date.now() } });
    otherZoneId = other.zoneId;
    zmPlantId = (await prisma.plant.create({ data: { name: 'P-acting-zm', zoneId: BigInt(ZM_ZONE) } })).plantId;
    otherPlantId = (await prisma.plant.create({ data: { name: 'P-acting-other', zoneId: otherZoneId } })).plantId;

    for (const id of deviceIds) await prisma.device.create({ data: { deviceId: id } });
    await seedState(deviceIds[0], zmPlantId);
    await seedState(deviceIds[1], otherPlantId);

    // #339 — a CSM may act in a zone only while that zone's ZM duty has cascaded to them, so the
    // precondition has to exist before the scope question can even be asked. This file is about
    // where the DATA comes from, not about who is allowed to ask; an Operations Head needs no window
    // (pan-India authority is theirs by role) and the OH case below deliberately opens none.
    zmOutWindowId = (
      await prisma.roleUnavailability.create({
        data: {
          role: 'ZONAL_MANAGER',
          zoneId: otherZoneId,
          windowStart: new Date(Date.now() - 60 * 60_000),
          windowEnd: null,
          reason: 'fixture: the acting precondition',
          createdByRole: 'OPERATIONS_HEAD',
        },
      })
    ).id;
  });

  afterAll(async () => {
    await prisma.roleUnavailability.deleteMany({ where: { id: zmOutWindowId } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [zmPlantId, otherPlantId] } } });
    await prisma.zone.deleteMany({ where: { zoneId: otherZoneId } });
    await app.close();
  });

  const zoneOverview = (token: string, actingZone?: string) => {
    const req = request(app.getHttpServer())
      .get('/api/dashboard/zone-overview')
      .set('Authorization', `Bearer ${token}`);
    return actingZone === undefined ? req : req.set('X-Acting-As-Zone', actingZone);
  };

  it('an Operations Head acting in a zone gets only that zone', async () => {
    const token = await login('ops.head@fsm.test');

    const all = await zoneOverview(token).expect(200);
    expect((all.body as { zoneId: string }[]).length).toBeGreaterThan(1);

    const acting = await zoneOverview(token, otherZoneId.toString()).expect(200);
    const rows = acting.body as { zoneId: string }[];
    expect(rows.map((r) => r.zoneId)).toEqual([otherZoneId.toString()]);
  });

  it('a CSM acting in a zone gets only that zone', async () => {
    const token = await login('csm@fsm.test');
    const acting = await zoneOverview(token, otherZoneId.toString()).expect(200);
    expect((acting.body as { zoneId: string }[]).map((r) => r.zoneId)).toEqual([otherZoneId.toString()]);
  });

  it('narrows the KPI strip too — acting counts fewer devices than pan-India', async () => {
    const token = await login('ops.head@fsm.test');
    const fleet = (t?: string) => {
      const req = request(app.getHttpServer())
        .get('/api/dashboard/fleet-summary')
        .set('Authorization', `Bearer ${token}`);
      return t === undefined ? req : req.set('X-Acting-As-Zone', t);
    };

    const panIndia = await fleet().expect(200);
    const acting = await fleet(otherZoneId.toString()).expect(200);

    expect(acting.body.operationalDevices).toBeGreaterThanOrEqual(1);
    expect(acting.body.operationalDevices).toBeLessThan(panIndia.body.operationalDevices);
  });

  it('cannot widen a Zonal Manager — the header is ignored for roles that cannot act', async () => {
    const token = await login('zm.north@fsm.test');
    const res = await zoneOverview(token, otherZoneId.toString()).expect(200);
    const rows = res.body as { zoneId: string }[];
    expect(rows.every((r) => r.zoneId === String(ZM_ZONE))).toBe(true);
  });
});
