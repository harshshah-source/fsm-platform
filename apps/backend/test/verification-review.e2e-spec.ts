import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TroubleshootSubmissionService } from '../src/ticketing/troubleshoot-submission.service';
import { VerificationService } from '../src/verification/verification.service';

/**
 * Issue 19 — the ZM Verification Review surface. GET /api/verification/review lists runs, zone-scoped,
 * default non-CLOSED newest-first, with derived row types + 24 h partial countdown; POST
 * /api/verification/:id/escalate moves a fraud-flagged ticket to ESCALATED with a mandatory reason.
 */
const NS = Date.now();
const T0 = new Date('2026-06-23T06:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const ANCHOR = { lat: 12.9716, lon: 77.5946 };
const NEAR = { lat: 12.9721, lon: 77.5946 };
const FAR = { lat: 13.4716, lon: 77.5946 };
const SE_ID = '22222222-2222-2222-2222-222222222222';

describe('verification review controller (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let verify: VerificationService;
  let submit: TroubleshootSubmissionService;

  let zoneId: bigint; // the ZM's zone (zone_id = 1 in auth seed)
  let companyId: bigint;
  let plantId: bigint;
  let snapshotRunId: bigint;
  const deviceIds: bigint[] = [];
  const ticketIds: string[] = [];

  const makeTicket = async (): Promise<{ ticketId: string; deviceId: bigint }> => {
    const deviceId = BigInt(11_800_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: T0 } });
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: cycle.cycleId, deviceId,
        plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: T0,
      },
    });
    ticketIds.push(ticket.ticketId);
    return { ticketId: ticket.ticketId, deviceId };
  };
  const addPing = (deviceId: bigint, time: Date, loc: { lat: number; lon: number }) =>
    prisma.rawDeviceSnapshot.create({ data: { runId: snapshotRunId, deviceId, gpsDatetime: time, lat: loc.lat, lon: loc.lon } });
  const submitForm = (ticketId: string) =>
    submit.submit({ ticketId, seId: SE_ID, clientSubmissionId: randomUUID(), rootCauseCategory: 'POWER_ISSUE', seGps: ANCHOR, presenceSource: 'FORM_GPS', actor: { userId: SE_ID, role: 'SERVICE_ENGINEER' }, now: T0 });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
    verify = app.get(VerificationService);
    submit = app.get(TroubleshootSubmissionService);

    // The ZM auth seed is zone_id = 1; create that zone if missing so scoping lines up.
    await prisma.zone.upsert({ where: { zoneId: 1n }, create: { zoneId: 1n, name: 'Z1-' + NS }, update: {} });
    zoneId = 1n;
    companyId = (await prisma.company.create({ data: { name: 'Co-vrev-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-vrev-' + NS, zoneId } })).plantId;
    snapshotRunId = (await prisma.snapshotRun.create({ data: { status: 'SUCCESS', startedAt: T0 } })).runId;
    await prisma.user.upsert({ where: { userId: SE_ID }, create: { userId: SE_ID, name: 'SE North', role: 'SERVICE_ENGINEER', phone: 'ph-vrev-' + NS, email: `se-vrev-${NS}@x.test`, zoneId }, update: {} });
    await prisma.engineerMaster.upsert({ where: { engineerId: SE_ID }, create: { engineerId: SE_ID, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 }, update: {} });
  });

  afterAll(async () => {
    await prisma.verificationRun.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.troubleshootingSubmission.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.rawDeviceSnapshot.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.auditLog.deleteMany({ where: { entityType: 'tickets', entityId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.snapshotRun.deleteMany({ where: { runId: snapshotRunId } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await app.close();
  });

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  }

  it('lists non-CLOSED rows for the ZM zone with derived row types and a partial countdown', async () => {
    // A fraud row, a partial row, and a CLOSED row (the last should be excluded by default).
    const fraud = await makeTicket();
    await submitForm(fraud.ticketId);
    for (const m of [1, 8, 16]) await addPing(fraud.deviceId, at(m), FAR);

    const partial = await makeTicket();
    await submitForm(partial.ticketId);
    await addPing(partial.deviceId, at(5), NEAR);

    const closed = await makeTicket();
    await submitForm(closed.ticketId);
    for (const m of [1, 20, 45, 65]) await addPing(closed.deviceId, at(m), NEAR);

    await verify.runVerification(at(70), { ticketIds: [fraud.ticketId, partial.ticketId, closed.ticketId] });

    const token = await login('zm.north@fsm.test');
    const res = await request(app.getHttpServer()).get('/api/verification/review').set('Authorization', `Bearer ${token}`).expect(200);
    const rows = res.body as Array<{ ticketId: string; rowType: string; partialDeadline: string | null }>;
    const byId = (id: string) => rows.find((r) => r.ticketId === id);

    expect(byId(fraud.ticketId)?.rowType).toBe('FAILED_FRAUD');
    expect(byId(partial.ticketId)?.rowType).toBe('PARTIAL_RECOVERY');
    expect(byId(partial.ticketId)?.partialDeadline).not.toBeNull();
    expect(byId(closed.ticketId)).toBeUndefined(); // CLOSED excluded by default
  });

  it('escalates a fraud-flagged ticket with a mandatory reason', async () => {
    const fraud = await makeTicket();
    await submitForm(fraud.ticketId);
    for (const m of [1, 8, 16]) await addPing(fraud.deviceId, at(m), FAR);
    await verify.runVerification(at(70), { ticketIds: [fraud.ticketId] });

    const token = await login('zm.north@fsm.test');
    // Missing reason → 400.
    await request(app.getHttpServer()).post(`/api/verification/${fraud.ticketId}/escalate`).set('Authorization', `Bearer ${token}`).send({}).expect(400);
    // With reason → OK, ticket ESCALATED.
    await request(app.getHttpServer()).post(`/api/verification/${fraud.ticketId}/escalate`).set('Authorization', `Bearer ${token}`).send({ reason: 'SE GPS 55km from device' }).expect(201);
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: fraud.ticketId } });
    expect(ticket.status).toBe('ESCALATED');
  });

  it('marks a row CLOSED_AUTO_RECOVERY', async () => {
    const partial = await makeTicket();
    await submitForm(partial.ticketId);
    await addPing(partial.deviceId, at(5), NEAR);
    await verify.runVerification(at(30), { ticketIds: [partial.ticketId] });

    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .post(`/api/verification/${partial.ticketId}/mark-auto-recovery`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: partial.ticketId } });
    expect(ticket.status).toBe('CLOSED_AUTO_RECOVERY');
  });

  it('forbids a non-manager role from the review list', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer()).get('/api/verification/review').set('Authorization', `Bearer ${token}`).expect(403);
  });
});
