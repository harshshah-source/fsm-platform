import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/token.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * #163 item 6 — `GET /api/me/vehicle-unavailability`, the SE-readable variant of the manager-only
 * `GET /vehicle-unavailability`. Filing a report today returns only `{result, id}`, so the "expected
 * back on [date]" state has no read at all. `secondarySlaSeconds` (the true, never-pausing elapsed
 * clock) must stay withheld — manager-only by design, PRD §299.
 */
const NS = Date.now();

describe('#163 item 6 — GET /api/me/vehicle-unavailability (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: TokenService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
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

  const makeTicket = async (): Promise<string> => {
    const deviceId = String(9_710_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: new Date('2026-06-27T09:00:00Z') } });
    const ticket = await prisma.ticket.create({
      data: { workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: cycle.cycleId, deviceId, plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: new Date('2026-06-27T09:00:00Z') },
    });
    ticketIds.push(ticket.ticketId);
    return ticket.ticketId;
  };

  const fileReport = async (token: string, ticketId: string, seId: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/vehicle-unavailability')
      .set('Authorization', `Bearer ${token}`)
      .send({ ticketId, seId, reasonCode: 'VEHICLE_ON_TRIP', transporterContacted: true, expectedFrom: '2026-06-28T09:00:00Z', notes: 'on a trip' })
      .expect(201);
    return res.body.id as string;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-mvu-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-mvu-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-mvu-' + NS, zoneId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({ data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'mvu-' + tag, email: `${tag}@mvu.test`, zoneId } });
    se = u.userId;
    userIds.push(se);
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });

    const tagO = randomUUID().slice(0, 8);
    const uO = await prisma.user.create({ data: { name: 'SE Other ' + tagO, role: 'SERVICE_ENGINEER', phone: 'mvu-o-' + tagO, email: `${tagO}@mvu.test`, zoneId } });
    seOther = uO.userId;
    userIds.push(seOther);
    await prisma.engineerMaster.create({ data: { engineerId: seOther, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
  });

  afterAll(async () => {
    await prisma.vehicleUnavailabilityReport.deleteMany({ where: { ticketId: { in: ticketIds } } });
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

  it("lists the caller's own report with the expected-back date, withholding secondarySlaSeconds — never another SE's", async () => {
    const ticketId = await makeTicket();
    const otherTicketId = await makeTicket();
    const zmToken = await login('zm.north@fsm.test');
    const reportId = await fileReport(zmToken, ticketId, se);
    await fileReport(zmToken, otherTicketId, seOther); // never appears in `se`'s list

    const res = await request(app.getHttpServer())
      .get('/api/me/vehicle-unavailability')
      .set('Authorization', `Bearer ${seToken()}`)
      .expect(200);

    expect(res.body.items).toHaveLength(1);
    const row = res.body.items[0];
    expect(row.id).toBe(reportId);
    expect(row.expectedFrom).toBe('2026-06-28T09:00:00.000Z');
    expect(row.status).toBe('OPEN');
    expect(row.slaPaused).toBe(true);
    expect(typeof row.primarySlaSeconds).toBe('number');
    expect(row).not.toHaveProperty('secondarySlaSeconds');
    expect(res.body.cursor).toBeNull();
  });

  it('forbids a non-SE role', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer()).get('/api/me/vehicle-unavailability').set('Authorization', `Bearer ${token}`).expect(403);
  });

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer()).get('/api/me/vehicle-unavailability').expect(401);
  });
});
