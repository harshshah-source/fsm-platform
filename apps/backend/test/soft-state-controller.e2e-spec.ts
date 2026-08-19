import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/token.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { SHARED_AUTH_SE_ID, ensureSharedSeCoversPlant, releaseSharedSePlantCoverage } from './fixtures/shared-auth-se';

/**
 * Issue 15 — the SE soft-state HTTP surface. POST /api/tickets/:id/soft-state drives the field-progress
 * chain for the authenticated SE (scoped to their own id), and POST /api/me/activity-ping stamps the
 * activity ping. SE-only; an out-of-order transition is a 409. Exercises auth + role + status mapping.
 */
const NS = Date.now();
const SE_ID = SHARED_AUTH_SE_ID; // se.north@fsm.test — shared across 16 specs, see fixtures/shared-auth-se.ts

describe('SE soft-state controller (e2e)', () => {
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
    const deviceId = String(11_300_000_000 + (NS % 100_000) * 10 + deviceIds.length);
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

    zoneId = (await prisma.zone.create({ data: { name: 'Z-sc-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-sc-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-sc-' + NS, zoneId } })).plantId;

    // The auth SE must exist as a users + engineer_master row (soft_states FK target) and must cover
    // this spec's plant. Idempotent, and MULTI_PLANT so it cannot race the partial unique (#255).
    await ensureSharedSeCoversPlant(prisma, { zoneId, plantId, tag: `sc-${NS}` });

    // A second, real SE with no coverage of `plantId` at all — the #162 wrong-SE regression case.
    const otherTag = randomUUID().slice(0, 8);
    const otherUser = await prisma.user.create({
      data: { name: 'SE Other', role: 'SERVICE_ENGINEER', phone: 'ph-sc-other-' + otherTag, email: `se-sc-other-${otherTag}@x.test`, zoneId },
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

  it('#162 — rejects a soft-state write from a correctly-authenticated SE outside the ticket coverage', async () => {
    const ticketId = await makeTicket();
    const token = tokens.signAccessToken({ user_id: otherSeId, role: 'SERVICE_ENGINEER', zone_id: Number(zoneId) });
    await request(app.getHttpServer())
      .post(`/api/tickets/${ticketId}/soft-state`)
      .set('Authorization', `Bearer ${token}`)
      .send({ target: 'VIEWED' })
      .expect(404);
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
