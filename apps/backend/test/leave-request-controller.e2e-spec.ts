import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { SeAvailabilityService } from '../src/engineers/se-availability.service';
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
  /** Leave requests whose #343 audit rows this spec is responsible for cleaning up. */
  const auditedRequestIds: string[] = [];

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
    if (auditedRequestIds.length > 0) {
      await prisma.auditLog.deleteMany({ where: { entityType: 'leave_requests', entityId: { in: auditedRequestIds } } });
    }
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

  /**
   * #343 AC1/AC2 — a leave decision is the SE's day being taken off the board, and until this slice
   * an approval left only an `SE_AVAILABILITY_SET` row with no link back to the request, while a
   * rejection left **nothing at all**: the one decision that comes with a mandatory reason was the one
   * the ledger could not reproduce. Both rows are keyed on the request id so the two halves of a
   * request's life — filed, then decided — meet on the same entity.
   */
  it('AC1/AC2 — approve and reject each write one audit row keyed on the request, and reject carries the reason', async () => {
    const token = await login('zm.north@fsm.test');

    const approved = await submit(token, { seId: se, type: 'ON_LEAVE', ...WIN, reason: 'wedding' }).expect(201);
    auditedRequestIds.push(approved.body.id);
    await request(app.getHttpServer())
      .post(`/api/leave-requests/${approved.body.id}/approve`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const rejected = await submit(token, { seId: se, type: 'WEEKLY_OFF', ...WIN }).expect(201);
    auditedRequestIds.push(rejected.body.id);
    await request(app.getHttpServer())
      .post(`/api/leave-requests/${rejected.body.id}/reject`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'zone would be uncovered' })
      .expect(200);

    const rows = await prisma.auditLog.findMany({
      where: { entityType: 'leave_requests', entityId: { in: auditedRequestIds } },
    });
    const approveRow = rows.find((r) => r.entityId === approved.body.id);
    const rejectRow = rows.find((r) => r.entityId === rejected.body.id);

    expect(rows).toHaveLength(2);
    expect(approveRow?.action).toBe('LEAVE_APPROVED');
    expect(approveRow?.actorRole).toBe('ZONAL_MANAGER');
    expect(approveRow?.metadata).toMatchObject({ seId: se, type: 'ON_LEAVE' });
    // The approval's consequence — the availability window the Recommender reads — is on the row, so
    // "why is this SE unbookable" is answerable from the ledger alone.
    expect((approveRow?.metadata as { availabilityId?: string }).availabilityId).toBeTruthy();

    expect(rejectRow?.action).toBe('LEAVE_REJECTED');
    expect(rejectRow?.metadata).toMatchObject({ seId: se, type: 'WEEKLY_OFF', reason: 'zone would be uncovered' });
  });

  it('rejects an invalid leave type (400)', async () => {
    const token = await login('zm.north@fsm.test');
    await submit(token, { seId: se, type: 'NOPE', ...WIN }).expect(400);
  });

  /**
   * #204 / B8 — a date-only `YYYY-MM-DD` (what the mobile form sends, `LeaveRequestFormScreen.tsx:46`)
   * names an **IST calendar day**. Before this, `new Date('2026-09-14')` gave UTC midnight = 05:30 IST,
   * so an SE on approved leave stayed bookable for the first 5h30m of the day they booked off.
   * Asserted through the same predicate the Recommender consumes, not by reading the stored columns.
   */
  it('B8 — a single-day leave covers that whole IST day (00:15 and 23:45 IST), and stops at the next IST midnight', async () => {
    const token = await login('zm.north@fsm.test');
    const sub = await submit(token, { seId: se, type: 'ON_LEAVE', windowStart: '2026-09-14', windowEnd: '2026-09-14' }).expect(201);
    await request(app.getHttpServer())
      .post(`/api/leave-requests/${sub.body.id}/approve`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const availability = app.get(SeAvailabilityService);
    // 00:15 IST on the 14th — the instant the old UTC-midnight window missed entirely.
    expect(await availability.currentStatus(se, new Date('2026-09-13T18:45:00Z'))).toBe('ON_LEAVE');
    expect(await availability.currentStatus(se, new Date('2026-09-14T18:15:00Z'))).toBe('ON_LEAVE'); // 23:45 IST
    expect(await availability.currentStatus(se, new Date('2026-09-14T18:45:00Z'))).toBe('AVAILABLE'); // 00:15 IST, 15th
    expect(await availability.currentStatus(se, new Date('2026-09-13T18:15:00Z'))).toBe('AVAILABLE'); // 23:45 IST, 13th
  });

  it('B8 — an end date one day before the start is still WINDOW_ORDER, not a zero-length window', async () => {
    const token = await login('zm.north@fsm.test');
    await submit(token, { seId: se, type: 'ON_LEAVE', windowStart: '2026-09-14', windowEnd: '2026-09-13' }).expect(400);
  });

  it('forbids an SE from the manager leave list (403) and unauth is 401', async () => {
    const seToken = await login('se.north@fsm.test');
    await request(app.getHttpServer()).get('/api/leave-requests').set('Authorization', `Bearer ${seToken}`).expect(403);
    await request(app.getHttpServer()).get('/api/leave-requests').expect(401);
  });
});
