import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { SHARED_AUTH_SE_ID, ensureSharedSeCoversPlant, releaseSharedSePlantCoverage } from './fixtures/shared-auth-se';

/**
 * Issue 70 — per-ticket troubleshoot form read (`GET /api/tickets/:id/forms`). Manager read surface
 * (ZM own-zone / CSM / OH all zones), mirroring the ticket detail scope. Unblocks the FE-09 Forms tab.
 */
const NS = Date.now();
const SE_ID = SHARED_AUTH_SE_ID; // se.north@fsm.test — shared across 16 specs, see fixtures/shared-auth-se.ts

describe('Ticket forms read (Issue 70, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];

  const makeTicket = async (): Promise<string> => {
    const deviceId = String(11_700_000_000 + (NS % 100_000) * 10 + deviceIds.length);
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

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  }

  async function submitForm(token: string, ticketId: string): Promise<void> {
    await request(app.getHttpServer())
      .post(`/api/tickets/${ticketId}/troubleshoot`)
      .set('Authorization', `Bearer ${token}`)
      .send({ clientSubmissionId: randomUUID(), rootCauseCategory: 'GPS_ANTENNA_ISSUE', diagnosisNotes: 'antenna reseated', seGps: { lat: 12.9, lon: 77.5 } })
      .expect(201);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-fr-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-fr-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-fr-' + NS, zoneId } })).plantId;
    await ensureSharedSeCoversPlant(prisma, { zoneId, plantId, tag: `fr-${NS}` });
  });

  afterAll(async () => {
    await releaseSharedSePlantCoverage(prisma, plantId);
    await prisma.troubleshootingSubmission.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.componentRequest.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.auditLog.deleteMany({ where: { entityType: 'tickets', entityId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await app.close();
  });

  it('returns the ticket forms for a manager (Operations Head, all zones)', async () => {
    const seToken = await login('se.north@fsm.test');
    const ticketId = await makeTicket();
    await submitForm(seToken, ticketId);

    const ohToken = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get(`/api/tickets/${ticketId}/forms`)
      .set('Authorization', `Bearer ${ohToken}`)
      .expect(200);

    expect(res.body.ticketId).toBe(ticketId);
    expect(Array.isArray(res.body.forms)).toBe(true);
    expect(res.body.forms).toHaveLength(1);
    expect(res.body.forms[0].rootCauseCategory).toBe('GPS_ANTENNA_ISSUE');
    expect(res.body.forms[0].diagnosisNotes).toBe('antenna reseated');
    expect(res.body.forms[0].submittedAt).toBeDefined();
  });

  it('returns an empty forms array for a ticket with no submissions', async () => {
    const ticketId = await makeTicket();
    const ohToken = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer())
      .get(`/api/tickets/${ticketId}/forms`)
      .set('Authorization', `Bearer ${ohToken}`)
      .expect(200);
    expect(res.body.forms).toEqual([]);
  });

  it('404s for a ZM reading a ticket outside their zone', async () => {
    const ticketId = await makeTicket(); // in the freshly-created zone, not the dev ZM's zone 1
    const zmToken = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .get(`/api/tickets/${ticketId}/forms`)
      .set('Authorization', `Bearer ${zmToken}`)
      .expect(404);
  });

  it('403s for a Service Engineer (manager-only read surface)', async () => {
    const ticketId = await makeTicket();
    const seToken = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .get(`/api/tickets/${ticketId}/forms`)
      .set('Authorization', `Bearer ${seToken}`)
      .expect(403);
  });
});
