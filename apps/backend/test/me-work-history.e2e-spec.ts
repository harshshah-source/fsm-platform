import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/token.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { MeWorkHistoryService } from '../src/me-tickets/me-work-history.service';

/**
 * #175 — `GET /api/me/work-history`, the per-day assigned/completed series behind the Home screen's
 * "Assigned vs Completed" chart (`docs/ui/mobile/home-dashboard.png`).
 *
 * The clock is pinned: `NOW` is 11:30 IST on 2026-06-21, so a `days=7` request covers the IST days
 * 06-15 … 06-21. Every fixture instant below is chosen to sit on a specific side of an IST midnight —
 * that is the behaviour under test, not incidental setup.
 */
const NS = Date.now();
const NOW = new Date('2026-06-21T06:00:00Z'); // 11:30 IST, 2026-06-21

/** UTC midnight of an IST calendar date — the form `@db.Date` columns marshal to. */
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('#175 — GET /api/me/work-history (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: TokenService;
  let history: MeWorkHistoryService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let se: string;
  let otherSe: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];

  const makeTicket = async (): Promise<string> => {
    const deviceId = String(9_840_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        failureCycleId: cycle.cycleId,
        deviceId,
        plantId,
        companyId,
        companyTier: 'GOLD',
        lastStateChangedAt: NOW,
      },
    });
    ticketIds.push(ticket.ticketId);
    return ticket.ticketId;
  };

  /** One schedule covering `[from, to]` with a single plant batch holding `tickets`. `removed` rows
   *  ride the same batch with a `removedAt` set — a ZM override, which must not count as assigned. */
  const makeSchedule = async (
    seId: string,
    from: string,
    to: string,
    tickets: string[],
    removed: string[] = [],
  ): Promise<void> => {
    const schedule = await prisma.workSchedule.create({
      data: { seId, zoneId, dateFrom: day(from), dateTo: day(to), status: 'ACTIVE', dispatchedAt: NOW },
    });
    const batch = await prisma.plantBatchAssignment.create({
      data: { scheduleId: schedule.scheduleId, plantId, seId, status: 'AUTO_ASSIGNED', stopSequence: 1 },
    });
    await prisma.batchAssignmentTicket.createMany({
      data: [
        ...tickets.map((ticketId, i) => ({ batchId: batch.batchId, ticketId, sortOrder: i + 1 })),
        ...removed.map((ticketId, i) => ({
          batchId: batch.batchId,
          ticketId,
          sortOrder: tickets.length + i + 1,
          removedAt: NOW,
        })),
      ],
    });
  };

  const close = (ticketId: string, at: string, toState = 'CLOSED') =>
    prisma.ticketEvent.create({ data: { ticketId, fromState: 'VERIFICATION_PENDING', toState, at: new Date(at) } });

  const seToken = (userId = se) =>
    tokens.signAccessToken({ user_id: userId, role: 'SERVICE_ENGINEER', zone_id: Number(zoneId) });

  const makeSe = async (): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'wh-' + tag, email: `${tag}@wh.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({
      data: { engineerId: u.userId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 },
    });
    await prisma.seCoverage.create({ data: { seId: u.userId, plantId, coverageType: 'DEDICATED' } });
    return u.userId;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);
    history = app.get(MeWorkHistoryService);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-wh-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-wh-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-wh-' + NS, zoneId } })).plantId;
    se = await makeSe();
    otherSe = await makeSe();
  });

  afterAll(async () => {
    const schedules = await prisma.workSchedule.findMany({ where: { zoneId }, select: { scheduleId: true } });
    const batches = await prisma.plantBatchAssignment.findMany({
      where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } },
      select: { batchId: true },
    });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.workSchedule.deleteMany({ where: { zoneId } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seCoverage.deleteMany({ where: { seId: { in: userIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await app.close();
  });

  it('returns a dense 7-day series with assigned/completed per IST day, zero rows included', async () => {
    const [t1, t2, t3, t4, t5, t6] = await Promise.all([
      makeTicket(), makeTicket(), makeTicket(), makeTicket(), makeTicket(), makeTicket(),
    ]);

    // 06-19: three assigned. 06-21 (today): two assigned, plus one the ZM removed from the plan.
    // No ticket appears live in both batches — `batch_assignment_tickets` carries a partial-unique
    // `(ticket_id) WHERE removed_at IS NULL` ("one active batch per ticket", schema.prisma:685), so a
    // fixture that reused one would be describing a state the database cannot hold.
    await makeSchedule(se, '2026-06-19', '2026-06-19', [t1, t2, t3]);
    await makeSchedule(se, '2026-06-21', '2026-06-21', [t4, t6], [t5]);

    await close(t1, '2026-06-19T10:00:00Z'); // 15:30 IST on the 19th — plainly inside the day
    // 00:15 IST on the 19th. Under UTC-midnight bucketing this lands on the 18th, where t3 is not
    // assigned, and would silently score 0 — the IST operating day (CONTEXT §19) is what makes it count.
    await close(t3, '2026-06-18T18:45:00Z');
    // 01:30 IST on the 21st, so it IS in the window's last day — but t2 was only ever assigned on the
    // 19th, so it must not count anywhere. This is the `completed ⊆ assigned` rule doing its job.
    await close(t2, '2026-06-20T20:00:00Z');
    // #229 D6 — t4's device healed itself before any form was submitted. That is a closure, but not
    // work this SE completed (CONTEXT §Auto-Recovery: "no SE effort is credited"), so it must stay in
    // `assigned` and score 0 in `completed`. Counted here until 2026-08-10.
    await close(t4, '2026-06-21T05:00:00Z', 'CLOSED_AUTO_RECOVERY');

    const view = await history.getWorkHistory(se, { now: NOW });

    expect(view.days.map((d) => d.date)).toEqual([
      '2026-06-15', '2026-06-16', '2026-06-17', '2026-06-18', '2026-06-19', '2026-06-20', '2026-06-21',
    ]);
    const byDate = new Map(view.days.map((d) => [d.date, d]));
    expect(byDate.get('2026-06-19')).toEqual({ date: '2026-06-19', assigned: 3, completed: 2 });
    // t5 (removed from the plan) is excluded from assigned; t6 is assigned but never closed; t4 is
    // assigned and closed, but auto-recovered — so the day reads 2 assigned, 0 completed (#229 D6).
    expect(byDate.get('2026-06-21')).toEqual({ date: '2026-06-21', assigned: 2, completed: 0 });
    // Days with no schedule are present as zeroes, never gaps — the chart renders 7 bars regardless.
    expect(byDate.get('2026-06-20')).toEqual({ date: '2026-06-20', assigned: 0, completed: 0 });
    expect(byDate.get('2026-06-15')).toEqual({ date: '2026-06-15', assigned: 0, completed: 0 });
    // Every bar fits its track.
    for (const d of view.days) expect(d.completed).toBeLessThanOrEqual(d.assigned);
  });

  it('scopes to the calling SE — another engineer\'s schedule never appears', async () => {
    const mine = await makeTicket();
    const theirs = await makeTicket();
    await makeSchedule(otherSe, '2026-06-17', '2026-06-17', [theirs]);
    await makeSchedule(se, '2026-06-17', '2026-06-17', [mine]);
    await close(theirs, '2026-06-17T09:00:00Z');

    const view = await history.getWorkHistory(se, { now: NOW });
    const seventeenth = view.days.find((d) => d.date === '2026-06-17')!;
    expect(seventeenth).toEqual({ date: '2026-06-17', assigned: 1, completed: 0 });
  });

  it('serves the SE surface over HTTP, honours ?days=, and bounds a junk value', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/me/work-history?days=3')
      .set('Authorization', `Bearer ${seToken()}`)
      .expect(200);
    expect(res.body.days).toHaveLength(3);

    const dflt = await request(app.getHttpServer())
      .get('/api/me/work-history')
      .set('Authorization', `Bearer ${seToken()}`)
      .expect(200);
    expect(dflt.body.days).toHaveLength(7);

    // A query value is an unvalidated string: neither garbage nor an absurd range may 500 or scan a
    // year of events behind an otherwise-fine screen.
    for (const q of ['days=banana', 'days=0', 'days=-4', 'days=100000']) {
      const bounded = await request(app.getHttpServer())
        .get(`/api/me/work-history?${q}`)
        .set('Authorization', `Bearer ${seToken()}`)
        .expect(200);
      expect(bounded.body.days.length).toBeGreaterThanOrEqual(1);
      expect(bounded.body.days.length).toBeLessThanOrEqual(31);
    }
  });

  it('is SE-only', async () => {
    const oh = tokens.signAccessToken({ user_id: se, role: 'OPS_HEAD', zone_id: Number(zoneId) });
    await request(app.getHttpServer())
      .get('/api/me/work-history')
      .set('Authorization', `Bearer ${oh}`)
      .expect(403);
  });
});
