import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/token.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * #163 item 2 — `GET /api/me/leave-requests`, the SE-readable variant of the manager-only
 * `GET /leave-requests`. Keyed on the caller's own `seId`; `decisionReason` (already on
 * `LeaveRequestRow`) is what an SE needs to see why a request was rejected.
 */
const NS = Date.now();
const ZONE1 = 1n; // seeded North zone — zm.north@fsm.test's own-zone scope

describe('#163 item 2 — GET /api/me/leave-requests (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: TokenService;
  let se: string;
  let seOther: string;
  const userIds: string[] = [];

  const seToken = () => tokens.signAccessToken({ user_id: se, role: 'SERVICE_ENGINEER', zone_id: Number(ZONE1) });

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  }

  const WIN = { windowStart: '2026-07-10T00:00:00Z', windowEnd: '2026-07-12T00:00:00Z' };
  const submit = (token: string, seId: string, body: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .post('/api/leave-requests')
      .set('Authorization', `Bearer ${token}`)
      .send({ seId, type: 'ON_LEAVE', ...WIN, ...body });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({ data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'mlr-' + tag, email: `${tag}@mlr.test`, zoneId: ZONE1 } });
    se = u.userId;
    userIds.push(se);
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId: ZONE1, dailyCapacity: 10 } });

    const tagO = randomUUID().slice(0, 8);
    const uO = await prisma.user.create({ data: { name: 'SE Other ' + tagO, role: 'SERVICE_ENGINEER', phone: 'mlr-o-' + tagO, email: `${tagO}@mlr.test`, zoneId: ZONE1 } });
    seOther = uO.userId;
    userIds.push(seOther);
    await prisma.engineerMaster.create({ data: { engineerId: seOther, coverageType: 'DEDICATED', zoneId: ZONE1, dailyCapacity: 10 } });
  });

  afterAll(async () => {
    await prisma.leaveRequest.deleteMany({ where: { seId: { in: userIds } } });
    await prisma.seAvailability.deleteMany({ where: { seId: { in: userIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await app.close();
  });

  it("lists the caller's own leave requests, including a rejected one's decisionReason — never another SE's", async () => {
    const zmToken = await login('zm.north@fsm.test');
    const pending = await submit(zmToken, se, { reason: 'family' }).expect(201);
    const toReject = await submit(zmToken, se, { windowStart: '2026-08-01T00:00:00Z', windowEnd: '2026-08-02T00:00:00Z' }).expect(201);
    await submit(zmToken, seOther).expect(201); // never appears in `se`'s list

    await request(app.getHttpServer())
      .post(`/api/leave-requests/${toReject.body.id}/reject`)
      .set('Authorization', `Bearer ${zmToken}`)
      .send({ reason: 'Coverage gap that week' })
      .expect(200);

    const res = await request(app.getHttpServer())
      .get('/api/me/leave-requests')
      .set('Authorization', `Bearer ${seToken()}`)
      .expect(200);

    const byId = new Map((res.body.items as Array<Record<string, unknown>>).map((r) => [r.id, r]));
    expect(byId.size).toBe(2);
    expect(byId.get(pending.body.id)).toMatchObject({ status: 'PENDING', reason: 'family' });
    expect(byId.get(toReject.body.id)).toMatchObject({ status: 'REJECTED', decisionReason: 'Coverage gap that week' });
    expect(res.body.cursor).toBeNull();
  });

  it('forbids a non-SE role', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer()).get('/api/me/leave-requests').set('Authorization', `Bearer ${token}`).expect(403);
  });

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer()).get('/api/me/leave-requests').expect(401);
  });
});
