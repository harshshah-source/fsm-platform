import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 25 slice 3 — HTTP Set Availability (`POST /api/engineers/:seId/availability`). Drives the
 * controller wiring + token→actor mapping + outcome→status mapping. The authorization branches
 * themselves (ZM own-zone / other-zone / Ops-Head / SE-self) are proven at the service layer in
 * `se-availability-service.e2e-spec.ts`; here we assert the HTTP surface: a ZM can set an own-zone
 * SE (201), a cross-zone SE is 403, Operations Head is never a setter (403), an unknown SE is 404,
 * a malformed body is 400, and an unauthenticated request is 401. Zones 1 (North) / 2 (South) are
 * the seeded zones the in-memory ZM token is scoped to.
 */
const NS = Date.now();

describe('Issue 25 slice 3 — Set Availability HTTP (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let seZ1: string; // SE in zone 1 (North) — ZM north's own zone
  let seZ2: string; // SE in zone 2 (South) — another zone
  const userIds: string[] = [];

  const makeSe = async (zoneId: bigint): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'av-' + tag, email: `${tag}-${NS}@av.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({
      data: { engineerId: u.userId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 },
    });
    return u.userId;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
    // The in-memory ZM-north token is scoped to zoneId 1; this suite also exercises a
    // cross-zone (zoneId 2) 403. On a non-pristine DB the org seed creates North/South at
    // higher sequence ids, so we cannot assume zones 1/2 exist. Ensure them by explicit id
    // (idempotent; name is @unique so use a namespaced name only when creating). Mirrors the
    // self-seeding pattern in the component-blocked / install controller e2e suites.
    await prisma.zone.upsert({ where: { zoneId: 1n }, create: { zoneId: 1n, name: 'Z1-av-' + NS }, update: {} });
    await prisma.zone.upsert({ where: { zoneId: 2n }, create: { zoneId: 2n, name: 'Z2-av-' + NS }, update: {} });
    seZ1 = await makeSe(1n);
    seZ2 = await makeSe(2n);
  });

  afterAll(async () => {
    await prisma.seAvailability.deleteMany({ where: { seId: { in: userIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await app.close();
  });

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  }

  const window = { windowStart: '2026-06-25T00:00:00Z', windowEnd: '2026-06-26T00:00:00Z' };

  it('a ZM sets an own-zone SE unavailable → 201 and the window is persisted', async () => {
    const token = await login('zm.north@fsm.test'); // zone 1
    const res = await request(app.getHttpServer())
      .post(`/api/engineers/${seZ1}/availability`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'ON_LEAVE', ...window, reason: 'leave' })
      .expect(201);
    expect(res.body.result).toBe('OK');
    expect(res.body.id).toBeTruthy();

    const row = await prisma.seAvailability.findFirst({ where: { seId: seZ1 } });
    expect(row?.status).toBe('ON_LEAVE');
    expect(row?.setByRole).toBe('ZONAL_MANAGER');
  });

  it('forbids a ZM from setting an SE in another zone → 403', async () => {
    const token = await login('zm.north@fsm.test'); // zone 1
    await request(app.getHttpServer())
      .post(`/api/engineers/${seZ2}/availability`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'OFF_SHIFT', ...window })
      .expect(403);
  });

  it('forbids Operations Head — never a setter → 403', async () => {
    const token = await login('ops.head@fsm.test');
    await request(app.getHttpServer())
      .post(`/api/engineers/${seZ1}/availability`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'OFF_SHIFT', ...window })
      .expect(403);
  });

  it('returns 404 for an unknown SE', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .post(`/api/engineers/${randomUUID()}/availability`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'ON_LEAVE', ...window })
      .expect(404);
  });

  it('rejects a malformed status with 400', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .post(`/api/engineers/${seZ1}/availability`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'NOT_A_STATUS', ...window })
      .expect(400);
  });

  it('rejects an unauthenticated request with 401', async () => {
    await request(app.getHttpServer())
      .post(`/api/engineers/${seZ1}/availability`)
      .send({ status: 'ON_LEAVE', ...window })
      .expect(401);
  });

  it('GET /api/engineers returns the zone SE list for a ZM (200)', async () => {
    const token = await login('zm.north@fsm.test'); // zone 1
    const res = await request(app.getHttpServer())
      .get('/api/engineers')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.map((r: { seId: string }) => r.seId)).toContain(seZ1);
  });

  it('GET /api/engineers/:seId returns the SE detail (200)', async () => {
    const token = await login('zm.north@fsm.test');
    const res = await request(app.getHttpServer())
      .get(`/api/engineers/${seZ1}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.seId).toBe(seZ1);
    expect(res.body.vanStock).toBeDefined();
    expect(res.body.dayPlan).toBeDefined();
  });

  it('GET /api/engineers/:seId is 404 for an unknown SE', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .get(`/api/engineers/${randomUUID()}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('forbids an SE from the manager SE-list read (403)', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .get('/api/engineers')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });
});
