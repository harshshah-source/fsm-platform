import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/token.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { SoftStateService } from '../src/soft-state/soft-state.service';
import { SeCoverageService } from '../src/shared-pool/se-coverage.service';

/**
 * #161 — the merged SE ticket-read surface (`GET /api/me/tickets`), per #172 Decision 3. Replaces the
 * day-plan/shared-pool split for the SE's own read: one list, `assigned` + `workState` per row, scoped
 * to the SE's coverage. Day Plan previously returned bare `{ticketId, sortOrder}` with no expansion —
 * this is what makes the row renderable without an N+1 client fetch.
 */
const NS = Date.now();

describe('#161 — GET /api/me/tickets (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: TokenService;
  let rec: RecommenderService;
  let dispatch: BatchAssignmentService;
  let soft: SoftStateService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let se: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  const NOW = new Date('2026-06-21T06:00:00Z');

  const makeTicket = async (): Promise<string> => {
    const deviceId = String(9_800_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        hasOpenFailureCycle: true,
        latestGpsDatetime: new Date(NOW.getTime() - 120 * 60_000),
        plantId,
        companyId,
        computedAt: NOW,
      },
    });
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

  const seToken = () => tokens.signAccessToken({ user_id: se, role: 'SERVICE_ENGINEER', zone_id: Number(zoneId) });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);
    rec = app.get(RecommenderService);
    dispatch = app.get(BatchAssignmentService);
    soft = new SoftStateService(prisma, new SeCoverageService(prisma));

    zoneId = (await prisma.zone.create({ data: { name: 'Z-mt-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-mt-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-mt-' + NS, zoneId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'mt-' + tag, email: `${tag}@mt.test`, zoneId },
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
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  }

  it('merges assigned (day-plan) and unassigned (pool) tickets into one scoped list', async () => {
    // `toAssign` exists before the dispatch run so the (sole, covered) SE is batch-assigned it;
    // `poolTicket` is created afterward so it is never seen by that run and stays genuinely
    // UNASSIGNED — otherwise, with one SE covering the plant, the recommender would batch both.
    const toAssign = await makeTicket();
    await rec.runForZone(zoneId, { now: NOW });
    await dispatch.dispatchForZone(zoneId, { dateFrom: NOW, dateTo: NOW, now: NOW });
    const poolTicket = await makeTicket();

    const res = await request(app.getHttpServer())
      .get('/api/me/tickets')
      .set('Authorization', `Bearer ${seToken()}`)
      .expect(200);

    const items = res.body.items as Array<{
      ticketId: string;
      ticketNo: number;
      ticketNoDisplay: string;
      assigned: boolean;
      workState: string;
      plantName: string;
    }>;
    const byId = new Map(items.map((i) => [i.ticketId, i]));

    expect(byId.get(toAssign)?.assigned).toBe(true);
    expect(byId.get(toAssign)?.workState).toBe('PLAN');
    expect(byId.get(poolTicket)?.assigned).toBe(false);
    expect(byId.get(poolTicket)?.workState).toBe('VISIT_NOW');
    expect(byId.get(toAssign)?.plantName).toBe('P-mt-' + NS);
    // #161 D-4 — the display label rides alongside the raw number so the client never re-derives padding.
    expect(typeof byId.get(toAssign)?.ticketNo).toBe('number');
    expect(byId.get(toAssign)?.ticketNoDisplay).toBe(`TCK-${String(byId.get(toAssign)?.ticketNo).padStart(5, '0')}`);
    expect(res.body.cursor).toBeNull();
  });

  it('reflects IN_WORK once the SE has an active ON_SITE soft state on the ticket', async () => {
    const ticketId = await makeTicket();
    await soft.advance({ ticketId, seId: se, target: 'VIEWED', now: NOW });
    await soft.advance({ ticketId, seId: se, target: 'ON_SITE', now: NOW });

    const res = await request(app.getHttpServer())
      .get('/api/me/tickets')
      .set('Authorization', `Bearer ${seToken()}`)
      .expect(200);

    const row = (res.body.items as Array<{ ticketId: string; workState: string; activeSoftState: string }>).find(
      (i) => i.ticketId === ticketId,
    );
    expect(row?.workState).toBe('IN_WORK');
    expect(row?.activeSoftState).toBe('ON_SITE');
  });

  it('never returns an out-of-coverage plant ticket', async () => {
    const otherPlant = (await prisma.plant.create({ data: { name: 'P-mt-other-' + NS, zoneId } })).plantId;
    const deviceId = String(9_850_000_000 + (NS % 100_000));
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
    const outOfScope = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT', status: 'OPEN', assignmentState: 'UNASSIGNED', failureCycleId: cycle.cycleId,
        deviceId, plantId: otherPlant, companyId, companyTier: 'GOLD', lastStateChangedAt: NOW,
      },
    });

    try {
      const res = await request(app.getHttpServer())
        .get('/api/me/tickets')
        .set('Authorization', `Bearer ${seToken()}`)
        .expect(200);
      const ids = (res.body.items as Array<{ ticketId: string }>).map((i) => i.ticketId);
      expect(ids).not.toContain(outOfScope.ticketId);
    } finally {
      await prisma.ticket.deleteMany({ where: { ticketId: outOfScope.ticketId } });
      await prisma.failureCycle.deleteMany({ where: { deviceId } });
      await prisma.device.deleteMany({ where: { deviceId } });
      await prisma.plant.deleteMany({ where: { plantId: otherPlant } });
    }
  });

  it('forbids a non-SE role', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer()).get('/api/me/tickets').set('Authorization', `Bearer ${token}`).expect(403);
  });

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer()).get('/api/me/tickets').expect(401);
  });
});
