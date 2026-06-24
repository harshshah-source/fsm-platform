import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 16, slice 4 — the troubleshoot HTTP surface. POST /api/tickets/:id/troubleshoot submits the
 * structured form for the authenticated SE: root_cause_category required (400 without it), success →
 * VERIFICATION_PENDING, a duplicate client_submission_id is a 200 no-op. SE-only.
 */
const NS = Date.now();
const SE_ID = '22222222-2222-2222-2222-222222222222'; // se.north@fsm.test (in-memory auth seed)

describe('SE troubleshoot controller (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  const deviceIds: bigint[] = [];
  const ticketIds: string[] = [];

  const makeTicket = async (): Promise<string> => {
    const deviceId = BigInt(11_500_000_000 + (NS % 100_000) * 10 + deviceIds.length);
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

    zoneId = (await prisma.zone.create({ data: { name: 'Z-tc-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-tc-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-tc-' + NS, zoneId } })).plantId;
    await prisma.user.upsert({
      where: { userId: SE_ID },
      create: { userId: SE_ID, name: 'SE North', role: 'SERVICE_ENGINEER', phone: 'ph-tc-' + NS, email: `se-tc-${NS}@x.test`, zoneId },
      update: {},
    });
    await prisma.engineerMaster.upsert({
      where: { engineerId: SE_ID },
      create: { engineerId: SE_ID, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 },
      update: {},
    });
  });

  afterAll(async () => {
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
