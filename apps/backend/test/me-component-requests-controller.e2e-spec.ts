import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/token.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * #163 item 5 — `GET /api/me/component-requests`, the SE-readable variant of the manager-only
 * oversight read. The SE `confirm-receipt`s a request today with no way to read it first, and the
 * Inventory screen's "2 Active" list has no source.
 */
const NS = Date.now();
const NOW = new Date('2026-06-26T09:00:00Z');

describe('#163 item 5 — GET /api/me/component-requests (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: TokenService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let componentId: bigint;
  let se: string;
  let seOther: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];

  const seToken = () => tokens.signAccessToken({ user_id: se, role: 'SERVICE_ENGINEER', zone_id: Number(zoneId) });

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  }

  const seedRequest = async (seId: string, status: 'REQUESTED' | 'SHIPPED' = 'REQUESTED'): Promise<string> => {
    const deviceId = String(12_300_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'WAITING_COMPONENT', openedAt: NOW } });
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: cycle.cycleId, deviceId,
        plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: NOW,
      },
    });
    ticketIds.push(ticket.ticketId);
    const submission = await prisma.troubleshootingSubmission.create({
      data: {
        ticketId: ticket.ticketId, failureCycleId: cycle.cycleId, submissionType: 'TROUBLESHOOTING_FORM',
        clientSubmissionId: randomUUID(), seId, presenceSource: 'NONE', componentUnavailable: true,
        componentUnavailableItem: componentId, rootCauseCategory: 'GPS_ANTENNA_ISSUE', submittedAt: NOW,
      },
    });
    const req = await prisma.componentRequest.create({
      data: {
        ticketId: ticket.ticketId, failureCycleId: cycle.cycleId, submissionId: submission.submissionId,
        seId, componentId, status,
        ...(status === 'SHIPPED' ? { trackingRef: 'TRK-1', deliveryDestination: 'SE_LOCATION', shippedAt: NOW } : {}),
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

    zoneId = (await prisma.zone.create({ data: { name: 'Z-mcr-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-mcr-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-mcr-' + NS, zoneId } })).plantId;
    componentId = (await prisma.componentMaster.create({ data: { name: 'ant-mcr-' + NS } })).componentId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({ data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'mcr-' + tag, email: `${tag}@mcr.test`, zoneId } });
    se = u.userId;
    userIds.push(se);
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });

    const tagO = randomUUID().slice(0, 8);
    const uO = await prisma.user.create({ data: { name: 'SE Other ' + tagO, role: 'SERVICE_ENGINEER', phone: 'mcr-o-' + tagO, email: `${tagO}@mcr.test`, zoneId } });
    seOther = uO.userId;
    userIds.push(seOther);
    await prisma.engineerMaster.create({ data: { engineerId: seOther, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
  });

  afterAll(async () => {
    await prisma.componentRequest.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.troubleshootingSubmission.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.componentMaster.deleteMany({ where: { componentId } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await app.close();
  });

  it("lists the caller's own component requests with ticket/component context — never another SE's", async () => {
    const shippedId = await seedRequest(se, 'SHIPPED');
    await seedRequest(seOther); // never appears in `se`'s list

    const res = await request(app.getHttpServer())
      .get('/api/me/component-requests')
      .set('Authorization', `Bearer ${seToken()}`)
      .expect(200);

    expect(res.body.items).toHaveLength(1);
    const row = res.body.items[0];
    expect(row.requestId).toBe(shippedId);
    expect(row.status).toBe('SHIPPED');
    expect(row.componentName).toBe('ant-mcr-' + NS);
    expect(row.companyName).toBe('Co-mcr-' + NS);
    expect(row.trackingRef).toBe('TRK-1');
    expect(res.body.cursor).toBeNull();
  });

  it('forbids a non-SE role', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer()).get('/api/me/component-requests').set('Authorization', `Bearer ${token}`).expect(403);
  });

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer()).get('/api/me/component-requests').expect(401);
  });
});
