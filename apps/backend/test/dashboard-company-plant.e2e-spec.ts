import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 06, slice 2 — `/api/dashboard/company-plant-overview` (AC#3, AC#6).
 *
 * Per (company, plant) inactive counts broken down by SLA bucket — the company → plant → device
 * drill-down's two aggregate levels (device level is the ticket list, filtered by plant). ZM scoped
 * to own zone; optional `companyId` filter; ACTIVE devices never counted.
 */
const ZM_ZONE = 1;

describe('Issue 06 slice 2 — /api/dashboard/company-plant-overview', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let otherZoneId: bigint;
  let companyAId: bigint;
  let companyBId: bigint;
  let zmPlantId: bigint;
  let otherPlantId: bigint;
  const deviceIds = [9_062_001n, 9_062_002n, 9_062_003n];

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  };

  const seedState = (deviceId: bigint, plantId: bigint, companyId: bigint, bucket: string | null) =>
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

    const other = await prisma.zone.create({ data: { name: 'Z-dash2-' + Date.now() } });
    otherZoneId = other.zoneId;
    const cA = await prisma.company.create({
      data: { name: 'CoA-dash2-' + Date.now(), companyTier: 'PLATINUM', companyPriorityRank: 'A' },
    });
    companyAId = cA.companyId;
    const cB = await prisma.company.create({
      data: { name: 'CoB-dash2-' + Date.now(), companyTier: 'SILVER', companyPriorityRank: 'C' },
    });
    companyBId = cB.companyId;
    const zmPlant = await prisma.plant.create({ data: { name: 'P-zm2', zoneId: BigInt(ZM_ZONE) } });
    zmPlantId = zmPlant.plantId;
    const otherPlant = await prisma.plant.create({ data: { name: 'P-other2', zoneId: otherZoneId } });
    otherPlantId = otherPlant.plantId;

    for (const id of deviceIds) await prisma.device.create({ data: { deviceId: id } });
    await seedState(deviceIds[0], zmPlantId, companyAId, 'CRITICAL'); // ZM zone, Co A
    await seedState(deviceIds[1], zmPlantId, companyBId, 'SEVERE'); // ZM zone, Co B
    await seedState(deviceIds[2], otherPlantId, companyAId, 'LONG_PENDING'); // other zone, Co A
  });

  afterAll(async () => {
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [zmPlantId, otherPlantId] } } });
    await prisma.company.deleteMany({ where: { companyId: { in: [companyAId, companyBId] } } });
    await prisma.zone.deleteMany({ where: { zoneId: otherZoneId } });
    await app.close();
  });

  it('gives Operations Head company+plant rows across zones with tier and bucket counts', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/dashboard/company-plant-overview')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const rows = res.body as Array<{
      companyId: string;
      companyTier: string;
      plantId: string;
      zoneId: string;
      totalInactive: number;
      byBucket: Record<string, number>;
    }>;
    const coAOther = rows.find(
      (r) => r.companyId === companyAId.toString() && r.plantId === otherPlantId.toString(),
    );
    expect(coAOther).toBeDefined();
    expect(coAOther!.companyTier).toBe('PLATINUM');
    expect(coAOther!.byBucket.LONG_PENDING).toBeGreaterThanOrEqual(1);
  });

  it('scopes a Zonal Manager to their own zone', async () => {
    const token = await login('zm.north@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/dashboard/company-plant-overview')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const rows = res.body as Array<{ zoneId: string; plantId: string }>;
    expect(rows.every((r) => r.zoneId === String(ZM_ZONE))).toBe(true);
    expect(rows.some((r) => r.plantId === otherPlantId.toString())).toBe(false);
  });

  it('filters by companyId', async () => {
    const token = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get(`/api/dashboard/company-plant-overview?companyId=${companyBId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const rows = res.body as Array<{ companyId: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.companyId === companyBId.toString())).toBe(true);
  });

  it('forbids a Service Engineer', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .get('/api/dashboard/company-plant-overview')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });
});
