import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TroubleshootSubmissionService } from '../src/ticketing/troubleshoot-submission.service';
import { VerificationService } from '../src/verification/verification.service';

/**
 * Issue 18, slice 4 — the verification read surface. GET /api/tickets/:id/verification gives the SE the
 * outcome / PARTIAL_RECOVERY (N pings) badge; GET /api/verification/fraud-flags is the ZM Phase-1
 * location-mismatch list. Exercises auth + role + the derived badge.
 */
const NS = Date.now();
const T0 = new Date('2026-06-23T06:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const ANCHOR = { lat: 12.9716, lon: 77.5946 };
const NEAR = { lat: 12.9721, lon: 77.5946 };
const FAR = { lat: 13.4716, lon: 77.5946 };
const SE_ID = '22222222-2222-2222-2222-222222222222';

describe('verification controller (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let verify: VerificationService;
  let submit: TroubleshootSubmissionService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let snapshotRunId: bigint;
  const deviceIds: bigint[] = [];
  const ticketIds: string[] = [];

  const makeTicket = async (): Promise<{ ticketId: string; deviceId: bigint }> => {
    const deviceId = BigInt(11_700_000_000 + (NS % 100_000) * 10 + deviceIds.length);
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

    zoneId = (await prisma.zone.create({ data: { name: 'Z-vc-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-vc-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-vc-' + NS, zoneId } })).plantId;
    snapshotRunId = (await prisma.snapshotRun.create({ data: { status: 'SUCCESS', startedAt: T0 } })).runId;
    await prisma.user.upsert({ where: { userId: SE_ID }, create: { userId: SE_ID, name: 'SE North', role: 'SERVICE_ENGINEER', phone: 'ph-vc-' + NS, email: `se-vc-${NS}@x.test`, zoneId }, update: {} });
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

  it('SE sees a PARTIAL_RECOVERY badge with the ping count while 1–2 pings are in', async () => {
    const { ticketId, deviceId } = await makeTicket();
    await submitForm(ticketId);
    await addPing(deviceId, at(5), NEAR);
    await verify.runVerification(at(30), { ticketIds: [ticketId] });

    const token = await login('se.north@fsm.test');
    const res = await request(app.getHttpServer())
      .get(`/api/tickets/${ticketId}/verification`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.badge).toBe('PARTIAL_RECOVERY');
    expect(res.body.pingsReceivedCount).toBe(1);
    expect(res.body.outcome).toBeNull();
  });

  it('SE sees the CLOSED outcome once verification passes', async () => {
    const { ticketId, deviceId } = await makeTicket();
    await submitForm(ticketId);
    for (const m of [1, 20, 45, 65]) await addPing(deviceId, at(m), NEAR);
    await verify.runVerification(at(70), { ticketIds: [ticketId] });

    const token = await login('se.north@fsm.test');
    const res = await request(app.getHttpServer())
      .get(`/api/tickets/${ticketId}/verification`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.badge).toBe('CLOSED');
    expect(res.body.outcome).toBe('CLOSED');
  });

  it('ZM fraud-flags lists a far Phase-1 ping with its distance delta', async () => {
    const { ticketId, deviceId } = await makeTicket();
    await submitForm(ticketId);
    for (const m of [1, 8, 16]) await addPing(deviceId, at(m), FAR);
    await verify.runVerification(at(70), { ticketIds: [ticketId] });

    const token = await login('zm.north@fsm.test');
    const res = await request(app.getHttpServer())
      .get('/api/verification/fraud-flags')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const flagged = (res.body as Array<{ ticketId: string; firstPingDistanceMeters: number }>).find((f) => f.ticketId === ticketId);
    expect(flagged).toBeDefined();
    expect(flagged!.firstPingDistanceMeters).toBeGreaterThan(500);
  });

  it('forbids an SE from the ZM fraud-flags list', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer()).get('/api/verification/fraud-flags').set('Authorization', `Bearer ${token}`).expect(403);
  });

  it('rejects an unauthenticated verification read', async () => {
    await request(app.getHttpServer()).get('/api/tickets/whatever/verification').expect(401);
  });
});
