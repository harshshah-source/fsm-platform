import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { SeAvailabilityService } from '../src/engineers/se-availability.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 26 slice 3 — Leave Request HTTP (`/api/leave-requests`). A ZM submits + lists + approves /
 * rejects / revokes own-zone leave; reject and revoke require a reason; bad input is 400; unauth is
 * 401. Zone 1 (North) is the seeded ZM's scope. Service-level auth branches are proven in
 * `leave-request-service`.
 *
 * #363 — each case files its own window. The spec used to reuse one, which the overlap guard now (
 * correctly) refuses: an SE cannot hold the same day twice.
 */
const NS = Date.now();

/** `[day, day+2)` in August 2026 — one case's window, as the wire carries it (full ISO instants). */
const win = (day: number) => ({
  windowStart: new Date(Date.UTC(2026, 7, day)).toISOString(),
  windowEnd: new Date(Date.UTC(2026, 7, day + 2)).toISOString(),
});
/** An instant inside `win(day)`. */
const inside = (day: number) => new Date(Date.UTC(2026, 7, day, 12));

describe('Issue 26 slice 3 — Leave Request HTTP (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let se: string;
  const userIds: string[] = [];
  /** Leave requests whose #343 audit rows the audit case asserts over. */
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
    const requests = await prisma.leaveRequest.findMany({ where: { seId: { in: userIds } }, select: { id: true } });
    await prisma.auditLog.deleteMany({
      where: { entityType: 'leave_requests', entityId: { in: requests.map((r) => String(r.id)) } },
    });
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

  const submit = (token: string, body: Record<string, unknown>) =>
    request(app.getHttpServer()).post('/api/leave-requests').set('Authorization', `Bearer ${token}`).send(body);

  const decide = (token: string, id: string, action: 'approve' | 'reject' | 'revoke', body?: Record<string, unknown>) =>
    request(app.getHttpServer()).post(`/api/leave-requests/${id}/${action}`).set('Authorization', `Bearer ${token}`).send(body ?? {});

  it('a ZM submits an own-zone leave request (201, PENDING)', async () => {
    const token = await login('zm.north@fsm.test');
    const res = await submit(token, { seId: se, type: 'ON_LEAVE', ...win(1), reason: 'family' }).expect(201);
    expect(res.body.result).toBe('OK');
    const row = await prisma.leaveRequest.findUniqueOrThrow({ where: { id: BigInt(res.body.id) } });
    expect(row.status).toBe('PENDING');
  });

  it('lists leave requests for the ZM and approves one', async () => {
    const token = await login('zm.north@fsm.test');
    const sub = await submit(token, { seId: se, type: 'ON_LEAVE', ...win(4) }).expect(201);

    const listed = await request(app.getHttpServer()).get('/api/leave-requests').set('Authorization', `Bearer ${token}`).expect(200);
    expect(listed.body.some((r: { id: string }) => r.id === sub.body.id)).toBe(true);

    await decide(token, sub.body.id, 'approve').expect(200);
    const row = await prisma.leaveRequest.findUniqueOrThrow({ where: { id: BigInt(sub.body.id) } });
    expect(row.status).toBe('APPROVED');
    expect(row.availabilityId).not.toBeNull();
  });

  it('reject requires a reason (400 without, 200 with)', async () => {
    const token = await login('zm.north@fsm.test');
    const sub = await submit(token, { seId: se, type: 'WEEKLY_OFF', ...win(7) }).expect(201);
    await decide(token, sub.body.id, 'reject').expect(400);
    await decide(token, sub.body.id, 'reject', { reason: 'coverage gap' }).expect(200);
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

    const approved = await submit(token, { seId: se, type: 'ON_LEAVE', ...win(10), reason: 'wedding' }).expect(201);
    auditedRequestIds.push(approved.body.id);
    await decide(token, approved.body.id, 'approve').expect(200);

    const rejected = await submit(token, { seId: se, type: 'WEEKLY_OFF', ...win(13) }).expect(201);
    auditedRequestIds.push(rejected.body.id);
    await decide(token, rejected.body.id, 'reject', { reason: 'zone would be uncovered' }).expect(200);

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

  /**
   * #363 AC3 — the wire half of the overlap guard. 409 rather than 400: the request is well-formed, it
   * conflicts with a day the SE has already claimed, and `conflictId` names the row that holds it so
   * the manager can open it instead of guessing.
   */
  it('#363 AC3 — an overlapping submit is 409 OVERLAP and names the conflicting request', async () => {
    const token = await login('zm.north@fsm.test');
    const first = await submit(token, { seId: se, type: 'ON_LEAVE', ...win(16) }).expect(201);

    const clash = await submit(token, { seId: se, type: 'ON_LEAVE', ...win(17) }).expect(409);
    expect(clash.body.code).toBe('OVERLAP');
    expect(clash.body.conflictId).toBe(first.body.id);

    await submit(token, { seId: se, type: 'ON_LEAVE', ...win(18) }).expect(201); // adjacent, end-exclusive
  });

  /**
   * #363 AC2/AC4 — the revoke route. Leave approved by mistake used to be terminal: the availability
   * window stayed on the board and the engineer was invisible to dispatch for the rest of it. The
   * reason is mandatory for the same reason a rejection's is — this is the write that puts an engineer
   * back on a day a manager had already taken them off.
   */
  it('#363 AC2/AC4 — revoke needs a reason, returns the day, audits LEAVE_REVOKED and reads back as REVOKED', async () => {
    const token = await login('zm.north@fsm.test');
    const sub = await submit(token, { seId: se, type: 'ON_LEAVE', ...win(21), reason: 'family' }).expect(201);
    await decide(token, sub.body.id, 'approve').expect(200);

    const availability = app.get(SeAvailabilityService);
    expect(await availability.currentStatus(se, inside(22))).toBe('ON_LEAVE');

    await decide(token, sub.body.id, 'revoke').expect(400); // no reason
    await decide(token, sub.body.id, 'revoke', { reason: 'SE is working after all' }).expect(200);

    expect(await availability.currentStatus(se, inside(22))).toBe('AVAILABLE');

    const listed = await request(app.getHttpServer()).get('/api/leave-requests').set('Authorization', `Bearer ${token}`).expect(200);
    expect(listed.body.find((r: { id: string }) => r.id === sub.body.id)).toMatchObject({
      status: 'REVOKED',
      decisionReason: 'SE is working after all',
    });

    const audit = await prisma.auditLog.findMany({
      where: { entityType: 'leave_requests', entityId: sub.body.id, action: 'LEAVE_REVOKED' },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toMatchObject({ seId: se, type: 'ON_LEAVE', reason: 'SE is working after all' });

    // A request that holds no availability window cannot be revoked.
    const pending = await submit(token, { seId: se, type: 'ON_LEAVE', ...win(24) }).expect(201);
    const notApproved = await decide(token, pending.body.id, 'revoke', { reason: 'too early' }).expect(400);
    expect(notApproved.body.code).toBe('LEAVE_NOT_APPROVED');
  });

  it('rejects an invalid leave type (400)', async () => {
    const token = await login('zm.north@fsm.test');
    await submit(token, { seId: se, type: 'NOPE', ...win(27) }).expect(400);
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
    await decide(token, sub.body.id, 'approve').expect(200);

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
