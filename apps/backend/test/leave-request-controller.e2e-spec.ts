import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 26 slice 3 — Leave Request HTTP (`/api/leave-requests`). A ZM submits + lists + approves /
 * rejects own-zone leave; reject requires a reason; bad input is 400; unauth is 401. Zone 1 (North)
 * is the seeded ZM's scope. Service-level auth branches are proven in `leave-request-service`.
 */
const NS = Date.now();

describe('Issue 26 slice 3 — Leave Request HTTP (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let se: string;
  const userIds: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'Leave SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'lrc-' + tag, email: `${tag}-${NS}@lrc.test`, zoneId: 1n },
    });
    se = u.userId;
    userIds.push(se);
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId: 1n, dailyCapacity: 10 } });
  });

  afterAll(async () => {
    await prisma.leaveRequest.deleteMany({ where: { seId: { in: userIds } } });
    await prisma.seAvailability.deleteMany({ where: { seId: { in: userIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await app.close();
  });

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  };
  const WIN = { windowStart: '2026-07-10T00:00:00Z', windowEnd: '2026-07-12T00:00:00Z' };

  const submit = (token: string, body: Record<string, unknown>) =>
    request(app.getHttpServer()).post('/api/leave-requests').set('Authorization', `Bearer ${token}`).send(body);

  it('a ZM submits an own-zone leave request (201, PENDING)', async () => {
    const token = await login('zm.north@fsm.test');
    const res = await submit(token, { seId: se, type: 'ON_LEAVE', ...WIN, reason: 'family' }).expect(201);
    expect(res.body.result).toBe('OK');
    const row = await prisma.leaveRequest.findUniqueOrThrow({ where: { id: BigInt(res.body.id) } });
    expect(row.status).toBe('PENDING');
  });

  it('lists leave requests for the ZM and approves one', async () => {
    const token = await login('zm.north@fsm.test');
    const sub = await submit(token, { seId: se, type: 'ON_LEAVE', ...WIN }).expect(201);

    const listed = await request(app.getHttpServer()).get('/api/leave-requests').set('Authorization', `Bearer ${token}`).expect(200);
    expect(listed.body.some((r: { id: string }) => r.id === sub.body.id)).toBe(true);

    await request(app.getHttpServer())
      .post(`/api/leave-requests/${sub.body.id}/approve`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const row = await prisma.leaveRequest.findUniqueOrThrow({ where: { id: BigInt(sub.body.id) } });
    expect(row.status).toBe('APPROVED');
    expect(row.availabilityId).not.toBeNull();
  });

  it('reject requires a reason (400 without, 200 with)', async () => {
    const token = await login('zm.north@fsm.test');
    const sub = await submit(token, { seId: se, type: 'WEEKLY_OFF', ...WIN }).expect(201);
    await request(app.getHttpServer()).post(`/api/leave-requests/${sub.body.id}/reject`).set('Authorization', `Bearer ${token}`).send({}).expect(400);
    await request(app.getHttpServer())
      .post(`/api/leave-requests/${sub.body.id}/reject`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'coverage gap' })
      .expect(200);
  });

  it('rejects an invalid leave type (400)', async () => {
    const token = await login('zm.north@fsm.test');
    await submit(token, { seId: se, type: 'NOPE', ...WIN }).expect(400);
  });

  it('forbids an SE from the manager leave list (403) and unauth is 401', async () => {
    const seToken = await login('se.north@fsm.test');
    await request(app.getHttpServer()).get('/api/leave-requests').set('Authorization', `Bearer ${seToken}`).expect(403);
    await request(app.getHttpServer()).get('/api/leave-requests').expect(401);
  });
});
