import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/token.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * #161 item 1 — `GET /api/me/tickets/:id`, the SE ticket-detail read. Covers TROUBLESHOOT (day-plan
 * assignment via WorkSchedule/PlantBatchAssignment/BatchAssignmentTicket), RECOVERY (direct
 * `Ticket.assignedSeId`, the literal gap `RecoveryController` — POST-only — left), and the
 * shared-pool visibility rule (OPEN/UNASSIGNED at a covered plant). Out-of-coverage and
 * assigned-to-another-SE both 404, never distinguished from "unknown ticket".
 */
const NS = Date.now();

describe('#161 item 1 — GET /api/me/tickets/:id (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: TokenService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint; // covered by seA only
  let otherPlantId: bigint; // uncovered by either SE
  let componentId: bigint;
  let seA: string;
  let seB: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  const scheduleIds: bigint[] = [];
  const NOW = new Date('2026-08-01T06:00:00Z');
  let scheduleDayOffset = 0; // each assigned-troubleshoot fixture gets its own day — the partial
  // unique index allows only one ACTIVE schedule per (se_id, zone_id, date_from).

  const makeDevice = async (): Promise<string> => {
    const deviceId = String(9_900_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId, isInactive: true, slaBucket: 'CRITICAL', eligibleForUptime: true,
        hasOpenFailureCycle: true, latestGpsDatetime: new Date(NOW.getTime() - 120 * 60_000),
        plantId, companyId, computedAt: NOW,
      },
    });
    return deviceId;
  };

  /** A TROUBLESHOOT ticket assigned to `seA` via a live day-plan (the batch-assignment path), with a
   *  two-deep repeat-failure chain and a WAITING_COMPONENT component request — exercises every read
   *  leg of the payload in one fixture. */
  const makeAssignedTroubleshootTicket = async (): Promise<string> => {
    const deviceId = await makeDevice();
    const priorCycle = await prisma.failureCycle.create({
      data: { deviceId, state: 'VERIFIED', openedAt: new Date(NOW.getTime() - 86_400_000), closedAt: new Date(NOW.getTime() - 43_200_000) },
    });
    const cycle = await prisma.failureCycle.create({
      data: {
        deviceId, state: 'WAITING_COMPONENT', openedAt: NOW, repeatFailure: true,
        previousFailureCycleId: priorCycle.cycleId, slaPaused: true, slaPauseReason: 'WAITING_COMPONENT',
        slaPausedAt: NOW,
      },
    });
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: cycle.cycleId, deviceId,
        plantId, companyId, companyTier: 'GOLD', repeatFailure: true, lastStateChangedAt: NOW,
      },
    });
    ticketIds.push(ticket.ticketId);

    const submission = await prisma.troubleshootingSubmission.create({
      data: {
        ticketId: ticket.ticketId, failureCycleId: cycle.cycleId, submissionType: 'TROUBLESHOOTING_FORM',
        clientSubmissionId: randomUUID(), seId: seA, presenceSource: 'NONE', componentUnavailable: true,
        componentUnavailableItem: componentId, rootCauseCategory: 'GPS_ANTENNA_ISSUE', submittedAt: NOW,
      },
    });
    await prisma.componentRequest.create({
      data: { ticketId: ticket.ticketId, failureCycleId: cycle.cycleId, submissionId: submission.submissionId, seId: seA, componentId, status: 'REQUESTED' },
    });

    const day = new Date(NOW.getTime() + scheduleDayOffset * 86_400_000);
    scheduleDayOffset++;
    const schedule = await prisma.workSchedule.create({
      data: { seId: seA, zoneId, dateFrom: day, dateTo: day, status: 'ACTIVE', dispatchedAt: day },
    });
    scheduleIds.push(schedule.scheduleId);
    const batch = await prisma.plantBatchAssignment.create({
      data: { scheduleId: schedule.scheduleId, plantId, seId: seA, status: 'AUTO_ASSIGNED', stopSequence: 1 },
    });
    await prisma.batchAssignmentTicket.create({ data: { batchId: batch.batchId, ticketId: ticket.ticketId, sortOrder: 1 } });

    return ticket.ticketId;
  };

  /** A RECOVERY ticket assigned to `seA` directly via `Ticket.assignedSeId` — no day-plan/batch row
   *  at all, mirroring how `RecoveryService.scheduleRecovery` actually dispatches. */
  const makeAssignedRecoveryTicket = async (): Promise<string> => {
    const deviceId = await makeDevice();
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'RECOVERY', status: 'SCHEDULED', deviceId, plantId, companyId, companyTier: 'GOLD',
        assignedSeId: seA, lastStateChangedAt: NOW,
      },
    });
    ticketIds.push(ticket.ticketId);
    return ticket.ticketId;
  };

  /** An OPEN/UNASSIGNED TROUBLESHOOT ticket at the covered plant — nobody's day plan, shared-pool
   *  visible only. */
  const makePoolTicket = async (): Promise<string> => {
    const deviceId = await makeDevice();
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT', status: 'OPEN', assignmentState: 'UNASSIGNED', failureCycleId: cycle.cycleId,
        deviceId, plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: NOW,
      },
    });
    ticketIds.push(ticket.ticketId);
    return ticket.ticketId;
  };

  const tokenFor = (seId: string) => tokens.signAccessToken({ user_id: seId, role: 'SERVICE_ENGINEER', zone_id: Number(zoneId) });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-mtd-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-mtd-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-mtd-' + NS, zoneId } })).plantId;
    otherPlantId = (await prisma.plant.create({ data: { name: 'P-mtd-other-' + NS, zoneId } })).plantId;
    componentId = (await prisma.componentMaster.create({ data: { name: 'cmp-mtd-' + NS } })).componentId;

    const tagA = randomUUID().slice(0, 8);
    const uA = await prisma.user.create({ data: { name: 'SE A ' + tagA, role: 'SERVICE_ENGINEER', phone: 'mtd-a-' + tagA, email: `${tagA}@mtd.test`, zoneId } });
    seA = uA.userId;
    userIds.push(seA);
    await prisma.engineerMaster.create({ data: { engineerId: seA, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
    await prisma.seCoverage.create({ data: { seId: seA, plantId, coverageType: 'DEDICATED' } });

    // seB is a genuine SERVICE_ENGINEER but covers NEITHER plant and is assigned NOTHING — the
    // "correct role, wrong SE" probe.
    const tagB = randomUUID().slice(0, 8);
    const uB = await prisma.user.create({ data: { name: 'SE B ' + tagB, role: 'SERVICE_ENGINEER', phone: 'mtd-b-' + tagB, email: `${tagB}@mtd.test`, zoneId } });
    seB = uB.userId;
    userIds.push(seB);
    await prisma.engineerMaster.create({ data: { engineerId: seB, coverageType: 'MULTI_PLANT', zoneId, dailyCapacity: 10 } });
  });

  afterAll(async () => {
    const batches = await prisma.plantBatchAssignment.findMany({ where: { scheduleId: { in: scheduleIds } }, select: { batchId: true } });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { scheduleId: { in: scheduleIds } } });
    await prisma.workSchedule.deleteMany({ where: { scheduleId: { in: scheduleIds } } });
    await prisma.componentRequest.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.troubleshootingSubmission.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seCoverage.deleteMany({ where: { seId: { in: userIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.componentMaster.deleteMany({ where: { componentId } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [plantId, otherPlantId] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await app.close();
  });

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  }

  it('returns the full detail payload for a day-plan-assigned TROUBLESHOOT ticket, with repeat-failure history and the component-request/SLA-pause badge', async () => {
    const ticketId = await makeAssignedTroubleshootTicket();

    const res = await request(app.getHttpServer())
      .get(`/api/me/tickets/${ticketId}`)
      .set('Authorization', `Bearer ${tokenFor(seA)}`)
      .expect(200);

    expect(res.body.ticketId).toBe(ticketId);
    expect(typeof res.body.ticketNo).toBe('number');
    expect(res.body.ticketNoDisplay).toBe(`TCK-${String(res.body.ticketNo).padStart(5, '0')}`);
    expect(res.body.workType).toBe('TROUBLESHOOT');
    expect(res.body.status).toBe('OPEN');
    expect(res.body.plantName).toBe('P-mtd-' + NS);
    expect(res.body.companyName).toBe('Co-mtd-' + NS);
    expect(res.body.companyTier).toBe('GOLD');
    expect(res.body.transporterName).toBeNull();
    expect(res.body.slaBucket).toBe('CRITICAL');
    expect(res.body.activeSoftState).toBeNull();
    expect(res.body.readinessHint).toBe('UNKNOWN');

    // Repeat-failure history: the ticket's own (WAITING_COMPONENT) cycle, then the prior VERIFIED one.
    expect(res.body.failureCycleHistory).toHaveLength(2);
    expect(res.body.failureCycleHistory[0].repeatFailure).toBe(true);
    expect(res.body.failureCycleHistory[0].closedAt).toBeNull();
    expect(res.body.failureCycleHistory[1].closedAt).not.toBeNull();

    // Component request + SLA-pause badge.
    expect(res.body.expectedComponents).toHaveLength(1);
    expect(res.body.expectedComponents[0].componentName).toBe('cmp-mtd-' + NS);
    expect(res.body.expectedComponents[0].status).toBe('REQUESTED');
    expect(res.body.componentRequestStatus).toBe('REQUESTED');
    expect(res.body.waitingComponentSince).not.toBeNull();

    // Payload stays phone-friendly.
    expect(Buffer.byteLength(JSON.stringify(res.body))).toBeLessThan(5 * 1024);
  });

  it('closes the RecoveryController GET gap: an SE reads their own assigned RECOVERY ticket', async () => {
    const ticketId = await makeAssignedRecoveryTicket();

    const res = await request(app.getHttpServer())
      .get(`/api/me/tickets/${ticketId}`)
      .set('Authorization', `Bearer ${tokenFor(seA)}`)
      .expect(200);

    expect(res.body.workType).toBe('RECOVERY');
    expect(res.body.status).toBe('SCHEDULED');
    expect(res.body.failureCycleHistory).toEqual([]);
    expect(res.body.expectedComponents).toEqual([]);
  });

  it('is readable via the shared-pool rule even when unassigned', async () => {
    const ticketId = await makePoolTicket();

    const res = await request(app.getHttpServer())
      .get(`/api/me/tickets/${ticketId}`)
      .set('Authorization', `Bearer ${tokenFor(seA)}`)
      .expect(200);

    expect(res.body.ticketId).toBe(ticketId);
    expect(res.body.status).toBe('OPEN');
  });

  it('404s an out-of-coverage ticket — never distinguishes it from unknown', async () => {
    const deviceId = String(9_950_000_000 + (NS % 100_000));
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
    const outOfScope = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT', status: 'OPEN', assignmentState: 'UNASSIGNED', failureCycleId: cycle.cycleId,
        deviceId, plantId: otherPlantId, companyId, companyTier: 'GOLD', lastStateChangedAt: NOW,
      },
    });
    try {
      await request(app.getHttpServer())
        .get(`/api/me/tickets/${outOfScope.ticketId}`)
        .set('Authorization', `Bearer ${tokenFor(seA)}`)
        .expect(404);
    } finally {
      await prisma.ticket.deleteMany({ where: { ticketId: outOfScope.ticketId } });
      await prisma.failureCycle.deleteMany({ where: { deviceId } });
      await prisma.device.deleteMany({ where: { deviceId } });
    }
  });

  it('404s for a correctly-authenticated SE reading another SE\'s assigned-but-not-covered ticket', async () => {
    const ticketId = await makeAssignedTroubleshootTicket();

    // seA can read it (assigned + covered)...
    await request(app.getHttpServer()).get(`/api/me/tickets/${ticketId}`).set('Authorization', `Bearer ${tokenFor(seA)}`).expect(200);
    // ...seB — a real SERVICE_ENGINEER, but neither assigned nor covering the plant — cannot.
    await request(app.getHttpServer()).get(`/api/me/tickets/${ticketId}`).set('Authorization', `Bearer ${tokenFor(seB)}`).expect(404);
  });

  it('404s an unknown ticket id', async () => {
    await request(app.getHttpServer())
      .get(`/api/me/tickets/${randomUUID()}`)
      .set('Authorization', `Bearer ${tokenFor(seA)}`)
      .expect(404);
  });

  it('forbids a non-SE role', async () => {
    const token = await login('zm.north@fsm.test');
    const ticketId = await makePoolTicket();
    await request(app.getHttpServer()).get(`/api/me/tickets/${ticketId}`).set('Authorization', `Bearer ${token}`).expect(403);
  });

  it('rejects an unauthenticated request', async () => {
    const ticketId = await makePoolTicket();
    await request(app.getHttpServer()).get(`/api/me/tickets/${ticketId}`).expect(401);
  });
});
