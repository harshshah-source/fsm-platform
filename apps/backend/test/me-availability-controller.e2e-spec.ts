import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/token.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * #163 item 7 — `GET /api/me/availability`, the SE-readable variant of `availabilityRows` on the
 * manager-only `GET /engineers/:seId` detail read. The SE can already self-set (`POST /engineers/:seId/
 * availability`, narrowed to SOFT_UNAVAILABLE) but had no way to read it back.
 */
const NS = Date.now();

describe('#163 item 7 — GET /api/me/availability (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: TokenService;

  let zoneId: bigint;
  let se: string;
  let seOther: string;
  let seEmpty: string;
  const userIds: string[] = [];

  const seToken = () => tokens.signAccessToken({ user_id: se, role: 'SERVICE_ENGINEER', zone_id: Number(zoneId) });
  const emptySeToken = () => tokens.signAccessToken({ user_id: seEmpty, role: 'SERVICE_ENGINEER', zone_id: Number(zoneId) });

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-mav-' + NS } })).zoneId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({ data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'mav-' + tag, email: `${tag}@mav.test`, zoneId } });
    se = u.userId;
    userIds.push(se);
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });

    const tagO = randomUUID().slice(0, 8);
    const uO = await prisma.user.create({ data: { name: 'SE Other ' + tagO, role: 'SERVICE_ENGINEER', phone: 'mav-o-' + tagO, email: `${tagO}@mav.test`, zoneId } });
    seOther = uO.userId;
    userIds.push(seOther);
    await prisma.engineerMaster.create({ data: { engineerId: seOther, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });

    const tagE = randomUUID().slice(0, 8);
    const uE = await prisma.user.create({ data: { name: 'SE Empty ' + tagE, role: 'SERVICE_ENGINEER', phone: 'mav-e-' + tagE, email: `${tagE}@mav.test`, zoneId } });
    seEmpty = uE.userId;
    userIds.push(seEmpty);
    await prisma.engineerMaster.create({ data: { engineerId: seEmpty, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
  });

  afterAll(async () => {
    await prisma.seAvailability.deleteMany({ where: { seId: { in: userIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await app.close();
  });

  it("lists the caller's own self-set availability window — never another SE's", async () => {
    await request(app.getHttpServer())
      .post(`/api/engineers/${se}/availability`)
      .set('Authorization', `Bearer ${seToken()}`)
      .send({ status: 'SOFT_UNAVAILABLE', windowStart: '2026-07-01T09:00:00Z', windowEnd: '2026-07-01T13:00:00Z', reason: 'clinic visit' })
      .expect(201);

    const csmToken = await login('csm@fsm.test'); // cross-zone manager — avoids the zone-clamp on zm.north's own zone
    await request(app.getHttpServer())
      .post(`/api/engineers/${seOther}/availability`)
      .set('Authorization', `Bearer ${csmToken}`)
      .send({ status: 'ON_LEAVE', windowStart: '2026-07-02T00:00:00Z', windowEnd: '2026-07-03T00:00:00Z' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get('/api/me/availability')
      .set('Authorization', `Bearer ${seToken()}`)
      .expect(200);

    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      status: 'SOFT_UNAVAILABLE',
      windowStart: '2026-07-01T09:00:00.000Z',
      windowEnd: '2026-07-01T13:00:00.000Z',
      reason: 'clinic visit',
      setByRole: 'SERVICE_ENGINEER',
    });
    expect(res.body.cursor).toBeNull();
  });

  it('returns an empty list for an SE with no availability windows set', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/me/availability')
      .set('Authorization', `Bearer ${emptySeToken()}`)
      .expect(200);
    expect(res.body.items).toEqual([]);
  });

  it('forbids a non-SE role', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer()).get('/api/me/availability').set('Authorization', `Bearer ${token}`).expect(403);
  });

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer()).get('/api/me/availability').expect(401);
  });
});
