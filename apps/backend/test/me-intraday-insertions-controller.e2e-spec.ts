import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/token.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * #163 item 3 — `GET /api/me/intraday-insertions`, the SE's own currently-live offer (with its
 * acceptance deadline). Today `GET /intraday-insertions` is manager-only, so after an app restart the
 * SE's live offer is recoverable only by scraping notifications. `NOT_OFFERED`/none must read as an
 * empty list, never a 403.
 */
const NS = Date.now();

describe('#163 item 3 — GET /api/me/intraday-insertions (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: TokenService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let se: string;
  let seOther: string;
  let seEmpty: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  const insertionIds: bigint[] = [];
  const NOW = new Date('2026-06-25T06:00:00Z');

  const seToken = () => tokens.signAccessToken({ user_id: se, role: 'SERVICE_ENGINEER', zone_id: Number(zoneId) });
  const emptySeToken = () => tokens.signAccessToken({ user_id: seEmpty, role: 'SERVICE_ENGINEER', zone_id: Number(zoneId) });

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  }

  const makeTicket = async (): Promise<string> => {
    const deviceId = String(9_870_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
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

  const makeInsertion = async (offeredSeId: string, status: 'PENDING_ACCEPTANCE' | 'ACCEPTED' | 'DECLINED' = 'PENDING_ACCEPTANCE'): Promise<bigint> => {
    const ticketId = await makeTicket();
    const row = await prisma.intradayInsertion.create({
      data: {
        ticketId, zoneId, offeredSeId, status,
        offeredAt: NOW, acceptanceDeadline: new Date(NOW.getTime() + 10 * 60_000),
      },
    });
    insertionIds.push(row.insertionId);
    return row.insertionId;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-mii-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-mii-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-mii-' + NS, zoneId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({ data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'mii-' + tag, email: `${tag}@mii.test`, zoneId } });
    se = u.userId;
    userIds.push(se);
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });

    const tagO = randomUUID().slice(0, 8);
    const uO = await prisma.user.create({ data: { name: 'SE Other ' + tagO, role: 'SERVICE_ENGINEER', phone: 'mii-o-' + tagO, email: `${tagO}@mii.test`, zoneId } });
    seOther = uO.userId;
    userIds.push(seOther);
    await prisma.engineerMaster.create({ data: { engineerId: seOther, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });

    const tagE = randomUUID().slice(0, 8);
    const uE = await prisma.user.create({ data: { name: 'SE Empty ' + tagE, role: 'SERVICE_ENGINEER', phone: 'mii-e-' + tagE, email: `${tagE}@mii.test`, zoneId } });
    seEmpty = uE.userId;
    userIds.push(seEmpty);
    await prisma.engineerMaster.create({ data: { engineerId: seEmpty, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
  });

  afterAll(async () => {
    await prisma.intradayInsertion.deleteMany({ where: { insertionId: { in: insertionIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await app.close();
  });

  it("returns the caller's own PENDING_ACCEPTANCE offer with its deadline — never another SE's, never a resolved one", async () => {
    const live = await makeInsertion(se, 'PENDING_ACCEPTANCE');
    await makeInsertion(se, 'ACCEPTED'); // already resolved — not a "current offer" anymore
    await makeInsertion(seOther, 'PENDING_ACCEPTANCE'); // another SE's live offer

    const res = await request(app.getHttpServer())
      .get('/api/me/intraday-insertions')
      .set('Authorization', `Bearer ${seToken()}`)
      .expect(200);

    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].insertionId).toBe(String(live));
    expect(res.body.items[0].status).toBe('PENDING_ACCEPTANCE');
    expect(res.body.items[0].acceptanceDeadline).toBeDefined();
    expect(res.body.cursor).toBeNull();
  });

  it('returns an empty list, not a 403, when nothing is currently offered', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/me/intraday-insertions')
      .set('Authorization', `Bearer ${emptySeToken()}`)
      .expect(200);
    expect(res.body.items).toEqual([]);
  });

  it('forbids a non-SE role', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer()).get('/api/me/intraday-insertions').set('Authorization', `Bearer ${token}`).expect(403);
  });

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer()).get('/api/me/intraday-insertions').expect(401);
  });
});
