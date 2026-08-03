import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/token.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';

/**
 * PRD:510 — "ZM manual same-day update arrives → push notification; updated Ticket is highlighted
 * (new addition at top of affected plant group; removed Ticket shows 'removed' label for one
 * session)." #161's own comment names this as the last open piece: a ticket removed from the SE's
 * day-plan batch (`BatchAssignmentTicket.removedAt`) today, via a ZM override, previously vanished
 * from `GET /api/me/tickets` with no trace — this covers the read side of that gap. The push half
 * already existed (`OverrideService` calls `notifier.dayPlanOverridden` on every action).
 */
const NS = Date.now();

describe('#161 — day-plan removal/deferral metadata on GET /api/me/tickets (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: TokenService;
  let rec: RecommenderService;
  let dispatch: BatchAssignmentService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let se: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  const NOW = new Date('2026-06-22T06:00:00Z');

  const makeTicket = async (): Promise<string> => {
    const deviceId = String(9_860_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId, isInactive: true, slaBucket: 'CRITICAL', eligibleForUptime: true,
        hasOpenFailureCycle: true, latestGpsDatetime: new Date(NOW.getTime() - 120 * 60_000),
        plantId, companyId, computedAt: NOW,
      },
    });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: cycle.cycleId, deviceId,
        plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: NOW,
      },
    });
    ticketIds.push(ticket.ticketId);
    return ticket.ticketId;
  };

  /** Dispatches `ticketId` onto `se`'s day plan (a fresh recommender run + dispatch for the whole
   *  zone — cheap enough at this fixture's one-ticket-one-SE scale) and returns the resulting batch id
   *  so the test can drive `POST /api/batches/:batchId/override` as the real ZM would. */
  const dispatchTicket = async (ticketId: string): Promise<bigint> => {
    await rec.runForZone(zoneId, { now: NOW });
    await dispatch.dispatchForZone(zoneId, { dateFrom: NOW, dateTo: NOW, now: NOW });
    const row = await prisma.batchAssignmentTicket.findFirstOrThrow({
      where: { ticketId },
      select: { batch: { select: { batchId: true } } },
    });
    return row.batch.batchId;
  };

  const seToken = () => tokens.signAccessToken({ user_id: se, role: 'SERVICE_ENGINEER', zone_id: Number(zoneId) });

  /** `deferredToDate` must be in the FUTURE relative to the server's real wall-clock `now` (there is
   *  no test hook to inject a fixed time over HTTP) for the "deferred → excluded from the pool"
   *  branch to actually hold — a hardcoded date would silently stop testing that once real time
   *  passes it. */
  const futureDate = (daysFromNow: number): string => new Date(Date.now() + daysFromNow * 86_400_000).toISOString().slice(0, 10);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);
    rec = app.get(RecommenderService);
    dispatch = app.get(BatchAssignmentService);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-mrm-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-mrm-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-mrm-' + NS, zoneId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'mrm-' + tag, email: `${tag}@mrm.test`, zoneId },
    });
    se = u.userId;
    userIds.push(se);
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
    await prisma.seCoverage.create({ data: { seId: se, plantId, coverageType: 'DEDICATED' } });
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
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.softState.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.dispatchDecisionTrace.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.auditLog.deleteMany({ where: { entityType: 'plant_batch_assignment' } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
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

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  }

  async function override(batchId: bigint, zmToken: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post(`/api/batches/${batchId}/override`)
      .set('Authorization', `Bearer ${zmToken}`)
      .send(body)
      .expect(200);
  }

  it('a plain REMOVE_TICKET carries removedFromPlanAt, un-assigns the row, and reappears via the pool', async () => {
    const ticketId = await makeTicket();
    const batchId = await dispatchTicket(ticketId);
    const zmToken = await login('ops.head@fsm.test');

    await override(batchId, zmToken, { action: 'REMOVE_TICKET', ticketId, reasonCode: 'REASSESS' });

    const res = await request(app.getHttpServer())
      .get('/api/me/tickets')
      .set('Authorization', `Bearer ${seToken()}`)
      .expect(200);

    const row = (res.body.items as Array<{ ticketId: string; assigned: boolean; removedFromPlanAt: string | null; deferredToDate: string | null }>).find(
      (i) => i.ticketId === ticketId,
    );
    expect(row).toBeDefined();
    expect(row?.assigned).toBe(false);
    expect(row?.removedFromPlanAt).not.toBeNull();
    expect(row?.deferredToDate).toBeNull();
  });

  it('a DEFER_TICKET removal carries deferredToDate and keeps the ticket visible (it would otherwise vanish entirely)', async () => {
    const ticketId = await makeTicket();
    const batchId = await dispatchTicket(ticketId);
    const zmToken = await login('ops.head@fsm.test');
    const deferredToDate = futureDate(30);

    await override(batchId, zmToken, { action: 'DEFER_TICKET', ticketId, deferredToDate, reasonCode: 'CUSTOMER_REQUEST' });

    const res = await request(app.getHttpServer())
      .get('/api/me/tickets')
      .set('Authorization', `Bearer ${seToken()}`)
      .expect(200);

    const row = (res.body.items as Array<{ ticketId: string; assigned: boolean; removedFromPlanAt: string | null; deferredToDate: string | null }>).find(
      (i) => i.ticketId === ticketId,
    );
    // Deferred to a future date: NOT assigned (removed from the batch) and NOT shared-pool-visible
    // (deferredUntil is in the future) — without this metadata the ticket would be entirely absent.
    expect(row).toBeDefined();
    expect(row?.assigned).toBe(false);
    expect(row?.removedFromPlanAt).not.toBeNull();
    expect(row?.deferredToDate).toBe(deferredToDate);
  });

  it('a normal, never-removed row carries null removal metadata', async () => {
    const ticketId = await makeTicket();
    await dispatchTicket(ticketId);

    const res = await request(app.getHttpServer())
      .get('/api/me/tickets')
      .set('Authorization', `Bearer ${seToken()}`)
      .expect(200);

    const row = (res.body.items as Array<{ ticketId: string; removedFromPlanAt: string | null; deferredToDate: string | null }>).find(
      (i) => i.ticketId === ticketId,
    );
    expect(row?.removedFromPlanAt).toBeNull();
    expect(row?.deferredToDate).toBeNull();
  });

  it('a removal from a PRIOR day (outside the same-day window) does not resurrect the ticket', async () => {
    const ticketId = await makeTicket();
    const batchId = await dispatchTicket(ticketId);
    const zmToken = await login('ops.head@fsm.test');

    await override(batchId, zmToken, { action: 'DEFER_TICKET', ticketId, deferredToDate: futureDate(30), reasonCode: 'CUSTOMER_REQUEST' });
    // Both the override call and the list read below use the server's real wall-clock `now` (there is
    // no test hook to inject a fixed time over HTTP) — back-date only the removal timestamp well into
    // the past so it falls outside whatever the real "today" is, simulating "the session where it
    // happened has long passed". `deferredUntil` stays in the future (set above) so the pool branch
    // remains correctly excluded too — otherwise this test would pass for the wrong reason.
    await prisma.batchAssignmentTicket.updateMany({
      where: { ticketId },
      data: { removedAt: new Date('2020-01-01T00:00:00Z') },
    });

    const res = await request(app.getHttpServer())
      .get('/api/me/tickets')
      .set('Authorization', `Bearer ${seToken()}`)
      .expect(200);

    const ids = (res.body.items as Array<{ ticketId: string }>).map((i) => i.ticketId);
    expect(ids).not.toContain(ticketId);
  });
});
