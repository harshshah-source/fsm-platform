import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 15 — the SE soft-state HTTP surface. POST /api/tickets/:id/soft-state drives the field-progress
 * chain for the authenticated SE (scoped to their own id), and POST /api/me/activity-ping stamps the
 * activity ping. SE-only; an out-of-order transition is a 409. Exercises auth + role + status mapping.
 */
const NS = Date.now();
const SE_ID = '22222222-2222-2222-2222-222222222222'; // se.north@fsm.test (in-memory auth seed)

describe('SE soft-state controller (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  const deviceIds: bigint[] = [];
  const ticketIds: string[] = [];

  const makeTicket = async (): Promise<string> => {
    const deviceId = BigInt(11_300_000_000 + (NS % 100_000) * 10 + deviceIds.length);
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

    zoneId = (await prisma.zone.create({ data: { name: 'Z-sc-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-sc-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-sc-' + NS, zoneId } })).plantId;

    // The auth SE must exist as a users + engineer_master row (soft_states FK target). Upsert idempotently.
    await prisma.user.upsert({
      where: { userId: SE_ID },
      create: { userId: SE_ID, name: 'SE North', role: 'SERVICE_ENGINEER', phone: 'ph-sc-' + NS, email: `se-sc-${NS}@x.test`, zoneId },
      update: {},
    });
    await prisma.engineerMaster.upsert({
      where: { engineerId: SE_ID },
      create: { engineerId: SE_ID, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 },
      update: {},
    });
  });

  afterAll(async () => {
    await prisma.softState.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    // Leave the shared SE_ID users/engineer rows; other suites may rely on them. Just detach from our zone.
    await prisma.engineerMaster.updateMany({ where: { engineerId: SE_ID, zoneId }, data: {} });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await app.close();
  });

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  }

  it('advances VIEWED for the authenticated SE', async () => {
    const token = await login('se.north@fsm.test');
    const ticketId = await makeTicket();
    const res = await request(app.getHttpServer())
      .post(`/api/tickets/${ticketId}/soft-state`)
      .set('Authorization', `Bearer ${token}`)
      .send({ target: 'VIEWED' })
      .expect(201);
    expect(res.body.result).toBe('OK');
    expect(res.body.softState.type).toBe('VIEWED');
    expect(typeof res.body.softState.softStateId).toBe('string'); // bigint serialized
  });

  it('rejects an out-of-order transition with 409', async () => {
    const token = await login('se.north@fsm.test');
    const ticketId = await makeTicket();
    await request(app.getHttpServer())
      .post(`/api/tickets/${ticketId}/soft-state`)
      .set('Authorization', `Bearer ${token}`)
      .send({ target: 'TROUBLESHOOT_STARTED' }) // skips VIEWED + ON_SITE
      .expect(409);
  });

  it('stamps an activity ping for the SE', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/me/activity-ping')
      .set('Authorization', `Bearer ${token}`)
      .expect(201);
    const eng = await prisma.engineerMaster.findUniqueOrThrow({ where: { engineerId: SE_ID } });
    expect(eng.lastActivityAt).not.toBeNull();
  });

  it('forbids a non-SE role', async () => {
    const token = await login('zm.north@fsm.test');
    const ticketId = await makeTicket();
    await request(app.getHttpServer())
      .post(`/api/tickets/${ticketId}/soft-state`)
      .set('Authorization', `Bearer ${token}`)
      .send({ target: 'VIEWED' })
      .expect(403);
  });

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer()).post('/api/me/activity-ping').expect(401);
  });
});
