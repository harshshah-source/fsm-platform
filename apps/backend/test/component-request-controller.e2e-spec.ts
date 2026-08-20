import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/token.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { SHARED_AUTH_SE_ID, ensureSharedAuthSe } from './fixtures/shared-auth-se';

/**
 * Issue 22, slice 6 — HTTP surface. Warehouse Manager queue + actions
 * (`/api/warehouse/requests`, WAREHOUSE_MANAGER): GET list, approve, ship, reject. SE Confirm Receipt
 * and the ZM-confirmed resubmit live under `/api/component-requests/:id`. Role-guarded; outcomes map
 * to 200 / 400 / 404 / 409.
 */
const NS = Date.now();
const SE_ID = SHARED_AUTH_SE_ID; // se.north@fsm.test — shared across 16 specs, see fixtures/shared-auth-se.ts

describe('Component Request HTTP surface (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: TokenService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let componentId: bigint;
  let otherSeId: string; // an SE who did NOT raise the request (#162 wrong-SE regression)
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];

  const seedRequest = async (status: 'REQUESTED' | 'SHIPPED'): Promise<string> => {
    const deviceId = String(12_100_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({
      data: {
        deviceId,
        state: 'WAITING_COMPONENT',
        openedAt: new Date(),
        slaPaused: true,
        slaPauseReason: 'WAITING_COMPONENT',
        slaPausedAt: new Date(),
      },
    });
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: cycle.cycleId, deviceId,
        plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: new Date(),
      },
    });
    ticketIds.push(ticket.ticketId);
    const submission = await prisma.troubleshootingSubmission.create({
      data: {
        ticketId: ticket.ticketId, failureCycleId: cycle.cycleId, submissionType: 'TROUBLESHOOTING_FORM',
        clientSubmissionId: randomUUID(), seId: SE_ID, presenceSource: 'NONE', componentUnavailable: true,
        componentUnavailableItem: componentId, rootCauseCategory: 'GPS_ANTENNA_ISSUE', submittedAt: new Date(),
      },
    });
    const req = await prisma.componentRequest.create({
      data: {
        ticketId: ticket.ticketId, failureCycleId: cycle.cycleId, submissionId: submission.submissionId,
        seId: SE_ID, componentId, status,
        ...(status === 'SHIPPED' ? { shippedAt: new Date(), trackingRef: 'T', deliveryDestination: 'SE_LOCATION' as const } : {}),
      },
    });
    return req.requestId;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);

    await prisma.zone.upsert({ where: { zoneId: 1n }, create: { zoneId: 1n, name: 'Z1-' + NS }, update: {} });
    zoneId = 1n;
    companyId = (await prisma.company.create({ data: { name: 'Co-crc-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-crc-' + NS, zoneId } })).plantId;
    componentId = (await prisma.componentMaster.create({ data: { name: 'cmp-crc-' + NS } })).componentId;
    await ensureSharedAuthSe(prisma, { zoneId, tag: `crc-${NS}` });

    const otherTag = randomUUID().slice(0, 8);
    const otherUser = await prisma.user.create({
      data: { name: 'SE Other', role: 'SERVICE_ENGINEER', phone: 'ph-crc-other-' + otherTag, email: `se-crc-other-${otherTag}@x.test`, zoneId },
    });
    otherSeId = otherUser.userId;
    await prisma.engineerMaster.create({ data: { engineerId: otherSeId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
  });

  afterAll(async () => {
    await prisma.engineerMaster.deleteMany({ where: { engineerId: otherSeId } });
    await prisma.user.deleteMany({ where: { userId: otherSeId } });
    await prisma.componentRequest.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.troubleshootingSubmission.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.auditLog.deleteMany({ where: { entityType: 'component_request' } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.componentMaster.deleteMany({ where: { componentId } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await app.close();
  });

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  };

  it('lets the Warehouse Manager list the queue; forbids an SE', async () => {
    const id = await seedRequest('REQUESTED');
    const wm = await login('wm@fsm.test');
    const res = await request(app.getHttpServer()).get('/api/warehouse/requests').set('Authorization', `Bearer ${wm}`).expect(200);
    expect((res.body as Array<{ requestId: string }>).some((r) => r.requestId === id)).toBe(true);

    const se = await login('se.north@fsm.test');
    await request(app.getHttpServer()).get('/api/warehouse/requests').set('Authorization', `Bearer ${se}`).expect(403);
  });

  it('runs the full HTTP lifecycle: approve → ship → confirm-receipt → confirm-resubmit', async () => {
    const id = await seedRequest('REQUESTED');
    const wm = await login('wm@fsm.test');

    await request(app.getHttpServer()).post(`/api/warehouse/requests/${id}/approve`).set('Authorization', `Bearer ${wm}`).expect(201);
    const shipRes = await request(app.getHttpServer())
      .post(`/api/warehouse/requests/${id}/ship`)
      .set('Authorization', `Bearer ${wm}`)
      .send({ trackingRef: 'TRK-9', deliveryDestination: 'SE_LOCATION' })
      .expect(201);
    expect(shipRes.body.request.status).toBe('SHIPPED');

    const se = await login('se.north@fsm.test');
    const recRes = await request(app.getHttpServer()).post(`/api/component-requests/${id}/confirm-receipt`).set('Authorization', `Bearer ${se}`).expect(201);
    expect(recRes.body.request.status).toBe('RECEIVED');

    const zm = await login('zm.north@fsm.test');
    const resubRes = await request(app.getHttpServer()).post(`/api/component-requests/${id}/confirm-resubmit`).set('Authorization', `Bearer ${zm}`).expect(201);
    expect(resubRes.body.ownership.mode).toBe('SOFT_OWN_ORIGINAL');
  });

  it('#162 — rejects confirm-receipt from a correctly-authenticated SE who did not raise the request (403)', async () => {
    const id = await seedRequest('SHIPPED');
    const token = tokens.signAccessToken({ user_id: otherSeId, role: 'SERVICE_ENGINEER', zone_id: Number(zoneId) });
    await request(app.getHttpServer())
      .post(`/api/component-requests/${id}/confirm-receipt`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    const row = await prisma.componentRequest.findUniqueOrThrow({ where: { requestId: id } });
    expect(row.status).toBe('SHIPPED'); // untouched — owner flow unaffected
  });

  it('rejects with a mandatory reason; 400 when the reason is missing', async () => {
    const id = await seedRequest('REQUESTED');
    const wm = await login('wm@fsm.test');
    await request(app.getHttpServer()).post(`/api/warehouse/requests/${id}/reject`).set('Authorization', `Bearer ${wm}`).send({}).expect(400);
    await request(app.getHttpServer()).post(`/api/warehouse/requests/${id}/reject`).set('Authorization', `Bearer ${wm}`).send({ reason: 'OOS' }).expect(201);
  });

  it('409 on an out-of-order transition, 404 on an unknown id', async () => {
    const id = await seedRequest('REQUESTED');
    const wm = await login('wm@fsm.test');
    // ship before approve → INVALID_STATE → 409
    await request(app.getHttpServer())
      .post(`/api/warehouse/requests/${id}/ship`)
      .set('Authorization', `Bearer ${wm}`)
      .send({ trackingRef: 'T', deliveryDestination: 'SE_LOCATION' })
      .expect(409);
    await request(app.getHttpServer()).post(`/api/warehouse/requests/${randomUUID()}/approve`).set('Authorization', `Bearer ${wm}`).expect(404);
  });
});
