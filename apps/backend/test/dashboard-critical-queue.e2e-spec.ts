import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 06, slice 3 — `/api/dashboard/critical-queue` (AC#4, AC#6).
 *
 * Open Troubleshoot tickets whose device is in a CRITICAL+ bucket, grouped by company/plant, with a
 * plant-cluster size signal and a (stubbed-empty) suggested-SE list (the Recommender is Issue 10).
 * Sub-CRITICAL buckets are excluded; ZM scoped to own zone.
 */
const ZM_ZONE = 1;

describe('Issue 06 slice 3 — /api/dashboard/critical-queue', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let companyId: bigint;
  let zmPlantId: bigint;
  const deviceIds = [9_063_001n, 9_063_002n];

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  };

  const seedTicketed = async (deviceId: bigint, plantId: bigint, bucket: string) => {
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        inactivityHours: 50,
        slaBucket: bucket as never,
        eligibleForUptime: true,
        hasOpenFailureCycle: true,
        plantId,
        companyId,
        computedAt: new Date(),
      },
    });
    const cycle = await prisma.failureCycle.create({
      data: { deviceId, state: 'OPEN', openedAt: new Date() },
    });
    await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        failureCycleId: cycle.cycleId,
        deviceId,
        plantId,
        companyId,
        companyTier: 'GOLD',
        lastStateChangedAt: new Date(),
      },
    });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    const company = await prisma.company.create({
      data: { name: 'Co-dash3-' + Date.now(), companyTier: 'GOLD', companyPriorityRank: 'B' },
    });
    companyId = company.companyId;
    const zmPlant = await prisma.plant.create({ data: { name: 'P-zm3', zoneId: BigInt(ZM_ZONE) } });
    zmPlantId = zmPlant.plantId;

    await seedTicketed(deviceIds[0], zmPlantId, 'HIGH_CRITICAL'); // CRITICAL+ → included
    await seedTicketed(deviceIds[1], zmPlantId, 'WARNING'); // sub-CRITICAL → excluded
  });

  afterAll(async () => {
    await prisma.ticket.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.plant.deleteMany({ where: { plantId: zmPlantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await app.close();
  });

  it('groups CRITICAL+ tickets by company/plant with a cluster size and stub SE suggestions', async () => {
    const token = await login('zm.north@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/dashboard/critical-queue')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const groups = res.body as Array<{
      companyId: string;
      plantId: string;
      zoneId: string;
      clusterSize: number;
      suggestedSes: unknown[];
      tickets: Array<{ deviceId: string; slaBucket: string }>;
    }>;
    const group = groups.find(
      (g) => g.companyId === companyId.toString() && g.plantId === zmPlantId.toString(),
    );
    expect(group).toBeDefined();
    expect(group!.zoneId).toBe(String(ZM_ZONE));
    // Only the HIGH_CRITICAL device — the WARNING one is excluded.
    expect(group!.tickets).toHaveLength(1);
    expect(group!.tickets[0].deviceId).toBe(deviceIds[0].toString());
    expect(group!.tickets[0].slaBucket).toBe('HIGH_CRITICAL');
    expect(group!.clusterSize).toBe(1);
    expect(Array.isArray(group!.suggestedSes)).toBe(true);
    expect(group!.suggestedSes).toHaveLength(0); // Recommender stub (Issue 10)
  });

  it('forbids a Service Engineer', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .get('/api/dashboard/critical-queue')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });
});
