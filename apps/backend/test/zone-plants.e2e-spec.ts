import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { SePlannerService } from '../src/planner/se-planner.service';

/**
 * Issue 14b — zone-scoped, manager-readable plant list (the planner grid's plant picker + cell labels).
 * A ZM sees only plants in their own zone; cross-zone roles (CSM / Operations Head) see all. SEs are
 * gated out. Distinct from the Ops-Head-only `/api/org/plants`, which a ZM cannot read.
 */
const NS = Date.now();

describe('Zone-scoped plant list — scoping (SePlannerService.listPlants)', () => {
  let prisma: PrismaService;
  let svc: SePlannerService;
  let zoneA: bigint;
  let zoneB: bigint;
  let plantA: bigint;
  let plantB: bigint;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new SePlannerService(prisma);
    zoneA = (await prisma.zone.create({ data: { name: 'ZP-A-' + NS } })).zoneId;
    zoneB = (await prisma.zone.create({ data: { name: 'ZP-B-' + NS } })).zoneId;
    plantA = (await prisma.plant.create({ data: { name: 'PA-' + NS, zoneId: zoneA } })).plantId;
    plantB = (await prisma.plant.create({ data: { name: 'PB-' + NS, zoneId: zoneB } })).plantId;
  });

  afterAll(async () => {
    await prisma.plant.deleteMany({ where: { plantId: { in: [plantA, plantB] } } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: [zoneA, zoneB] } } });
    await prisma.onModuleDestroy();
  });

  it('a ZM sees only plants in their own zone', async () => {
    const rows = await svc.listPlants({ role: 'ZONAL_MANAGER', zoneId: Number(zoneA) });
    const ids = rows.map((r) => r.plantId);
    expect(ids).toContain(String(plantA));
    expect(ids).not.toContain(String(plantB));
    expect(rows.every((r) => r.zoneId === String(zoneA))).toBe(true);
  });

  it('a cross-zone role (Operations Head) sees plants across zones', async () => {
    const rows = await svc.listPlants({ role: 'OPERATIONS_HEAD', zoneId: null });
    const ids = rows.map((r) => r.plantId);
    expect(ids).toContain(String(plantA));
    expect(ids).toContain(String(plantB));
  });
});

describe('Zone-scoped plant list — HTTP gating (GET /api/planner/plants)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  }

  it('returns an array for a ZM', async () => {
    const token = await login('zm.north@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/planner/plants')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('forbids an SE', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .get('/api/planner/plants')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer()).get('/api/planner/plants').expect(401);
  });
});
