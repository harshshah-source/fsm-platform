import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ZmScheduleQueryService } from '../src/scheduling/zm-schedule-query.service';

/**
 * Issue 13b — zone-scoped, manager-readable SE list (the target-SE picker source for Swap / Reassign /
 * Split and the Critical-queue assign). A ZM sees only SEs in their own zone; cross-zone roles
 * (CSM / Operations Head) see all. SEs are gated out. Distinct from the Ops-Head-only
 * `/api/org/engineers`, which a ZM cannot read.
 */
const NS = Date.now();

describe('Zone-scoped SE list — scoping (ZmScheduleQueryService.listZoneEngineers)', () => {
  let prisma: PrismaService;
  let svc: ZmScheduleQueryService;
  let zoneA: bigint;
  let zoneB: bigint;
  const userIds: string[] = [];
  let seA: string;
  let seB: string;

  const makeSe = async (zoneId: bigint): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@ze.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({
      data: { engineerId: u.userId, coverageType: 'MULTI_PLANT', zoneId, dailyCapacity: 10 },
    });
    return u.userId;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new ZmScheduleQueryService(prisma);
    zoneA = (await prisma.zone.create({ data: { name: 'ZE-A-' + NS } })).zoneId;
    zoneB = (await prisma.zone.create({ data: { name: 'ZE-B-' + NS } })).zoneId;
    seA = await makeSe(zoneA);
    seB = await makeSe(zoneB);
  });

  afterAll(async () => {
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: [zoneA, zoneB] } } });
    await prisma.onModuleDestroy();
  });

  it('a ZM sees only engineers in their own zone', async () => {
    const rows = await svc.listZoneEngineers({ role: 'ZONAL_MANAGER', zoneId: Number(zoneA) });
    const ids = rows.map((r) => r.engineerId);
    expect(ids).toContain(seA);
    expect(ids).not.toContain(seB);
    expect(rows.every((r) => r.zoneId === String(zoneA))).toBe(true);
  });

  it('a cross-zone role (Operations Head) sees engineers across zones', async () => {
    const rows = await svc.listZoneEngineers({ role: 'OPERATIONS_HEAD', zoneId: null });
    const ids = rows.map((r) => r.engineerId);
    expect(ids).toContain(seA);
    expect(ids).toContain(seB);
  });
});

describe('Zone-scoped SE list — HTTP gating (GET /api/schedules/engineers)', () => {
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
      .get('/api/schedules/engineers')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('forbids an SE', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .get('/api/schedules/engineers')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer()).get('/api/schedules/engineers').expect(401);
  });
});
