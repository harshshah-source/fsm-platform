import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/token.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { SHARED_AUTH_SE_ID, ensureSharedSeCoversPlant, releaseSharedSePlantCoverage } from './fixtures/shared-auth-se';

/**
 * Issue 16, slice 4 — the troubleshoot HTTP surface. POST /api/tickets/:id/troubleshoot submits the
 * structured form for the authenticated SE: root_cause_category required (400 without it), success →
 * VERIFICATION_PENDING, a duplicate client_submission_id is a 200 no-op. SE-only.
 */
const NS = Date.now();
const SE_ID = SHARED_AUTH_SE_ID; // se.north@fsm.test — shared across 16 specs, see fixtures/shared-auth-se.ts

describe('SE troubleshoot controller (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: TokenService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let otherSeId: string; // an SE with NO coverage of `plantId` (#162 wrong-SE regression)
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];

  const makeTicket = async (): Promise<string> => {
    const deviceId = String(11_500_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: new Date() } });
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        failureCycleId: cycle.cycleId,
        deviceId,
        plantId,
        companyId,
        companyTier: 'GOLD',
        lastStateChangedAt: new Date(),
      },
    });
    ticketIds.push(ticket.ticketId);
    return ticket.ticketId;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-tc-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-tc-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-tc-' + NS, zoneId } })).plantId;
    await ensureSharedSeCoversPlant(prisma, { zoneId, plantId, tag: `tc-${NS}` });

    // A second, real SE with no coverage of `plantId` at all — the #162 wrong-SE regression case.
    const otherTag = randomUUID().slice(0, 8);
    const otherUser = await prisma.user.create({
      data: { name: 'SE Other', role: 'SERVICE_ENGINEER', phone: 'ph-tc-other-' + otherTag, email: `se-tc-other-${otherTag}@x.test`, zoneId },
    });
    otherSeId = otherUser.userId;
    await prisma.engineerMaster.create({ data: { engineerId: otherSeId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
  });

  afterAll(async () => {
    // se_coverage first: se_coverage_se_id_fkey is ON DELETE RESTRICT (#255 AC-3). And guard on
    // `otherSeId` — if beforeAll threw before it was assigned, an undefined filter is dropped by
    // Prisma and `deleteMany` would clear engineer_master wholesale.
    await releaseSharedSePlantCoverage(prisma, plantId);
    if (otherSeId) {
      await prisma.engineerMaster.deleteMany({ where: { engineerId: otherSeId } });
      await prisma.user.deleteMany({ where: { userId: otherSeId } });
    }
    await prisma.troubleshootingSubmission.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.auditLog.deleteMany({ where: { entityType: 'tickets', entityId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await app.close();
  });

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  }

  it('submits the form and moves the ticket to VERIFICATION_PENDING', async () => {
    const token = await login('se.north@fsm.test');
    const ticketId = await makeTicket();
    const res = await request(app.getHttpServer())
      .post(`/api/tickets/${ticketId}/troubleshoot`)
      .set('Authorization', `Bearer ${token}`)
      .send({ clientSubmissionId: randomUUID(), rootCauseCategory: 'GPS_ANTENNA_ISSUE', seGps: { lat: 12.9, lon: 77.5 } })
      .expect(201);
    expect(res.body.result).toBe('OK');
    expect(res.body.duplicate).toBe(false);
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    expect(ticket.status).toBe('VERIFICATION_PENDING');
  });

  it('rejects a submission without root_cause_category (400)', async () => {
    const token = await login('se.north@fsm.test');
    const ticketId = await makeTicket();
    await request(app.getHttpServer())
      .post(`/api/tickets/${ticketId}/troubleshoot`)
      .set('Authorization', `Bearer ${token}`)
      .send({ clientSubmissionId: randomUUID() })
      .expect(400);
  });

  it('returns the existing record on a duplicate client_submission_id', async () => {
    const token = await login('se.north@fsm.test');
    const ticketId = await makeTicket();
    const clientSubmissionId = randomUUID();
    const first = await request(app.getHttpServer())
      .post(`/api/tickets/${ticketId}/troubleshoot`)
      .set('Authorization', `Bearer ${token}`)
      .send({ clientSubmissionId, rootCauseCategory: 'WIRING_ISSUE' })
      .expect(201);
    const second = await request(app.getHttpServer())
      .post(`/api/tickets/${ticketId}/troubleshoot`)
      .set('Authorization', `Bearer ${token}`)
      .send({ clientSubmissionId, rootCauseCategory: 'WIRING_ISSUE' })
      .expect(201);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.submission.submissionId).toBe(first.body.submission.submissionId);
  });

  it('#162 — rejects a submission from a correctly-authenticated SE outside the ticket coverage (404, no submission row)', async () => {
    const ticketId = await makeTicket();
    const token = tokens.signAccessToken({ user_id: otherSeId, role: 'SERVICE_ENGINEER', zone_id: Number(zoneId) });
    await request(app.getHttpServer())
      .post(`/api/tickets/${ticketId}/troubleshoot`)
      .set('Authorization', `Bearer ${token}`)
      .send({ clientSubmissionId: randomUUID(), rootCauseCategory: 'UNKNOWN' })
      .expect(404);
    const rows = await prisma.troubleshootingSubmission.findMany({ where: { ticketId } });
    expect(rows.length).toBe(0);
  });

  it('forbids a non-SE role', async () => {
    const token = await login('zm.north@fsm.test');
    const ticketId = await makeTicket();
    await request(app.getHttpServer())
      .post(`/api/tickets/${ticketId}/troubleshoot`)
      .set('Authorization', `Bearer ${token}`)
      .send({ clientSubmissionId: randomUUID(), rootCauseCategory: 'UNKNOWN' })
      .expect(403);
  });
});
