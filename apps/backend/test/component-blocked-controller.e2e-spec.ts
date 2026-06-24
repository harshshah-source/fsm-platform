import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 21, slices 4–5 — the Component-Blocked Queue (`/api/component-blocked`, ZM read-only) and the SE
 * van-stock surface (`/api/me/van-stock`). The queue is zone-scoped; a row aged > 7 days with no WM
 * action shows `warehouseOverdue`. The SE surface returns carried components + Common-Kit completeness.
 */
const NS = Date.now();
const SE_ID = '22222222-2222-2222-2222-222222222222';

describe('Component-Blocked Queue + SE van-stock (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let sim: bigint;
  const deviceIds: bigint[] = [];
  const ticketIds: string[] = [];

  const makeBlockedTicket = async (blockedAt: Date): Promise<string> => {
    const deviceId = BigInt(12_000_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: new Date() } });
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: cycle.cycleId, deviceId,
        plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: new Date(),
      },
    });
    ticketIds.push(ticket.ticketId);
    await prisma.componentBlockedQueue.create({
      data: {
        ticketId: ticket.ticketId, seId: SE_ID, reason: 'COMMON_KIT_INCOMPLETE',
        missingComponents: [{ componentId: String(sim), name: 'SIM', shortBy: 1 }],
        blockedAt,
      },
    });
    return ticket.ticketId;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    await prisma.zone.upsert({ where: { zoneId: 1n }, create: { zoneId: 1n, name: 'Z1-' + NS }, update: {} });
    zoneId = 1n;
    companyId = (await prisma.company.create({ data: { name: 'Co-cbq-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-cbq-' + NS, zoneId } })).plantId;
    sim = (await prisma.componentMaster.create({ data: { name: 'SIM-cbq-' + NS } })).componentId;
    await prisma.user.upsert({ where: { userId: SE_ID }, create: { userId: SE_ID, name: 'SE North', role: 'SERVICE_ENGINEER', phone: 'ph-cbq-' + NS, email: `se-cbq-${NS}@x.test`, zoneId }, update: {} });
    await prisma.engineerMaster.upsert({ where: { engineerId: SE_ID }, create: { engineerId: SE_ID, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 }, update: {} });
    await prisma.seVanStock.deleteMany({ where: { seId: SE_ID, componentId: sim } });
    await prisma.seVanStock.create({ data: { seId: SE_ID, componentId: sim, qty: 4 } });
  });

  afterAll(async () => {
    await prisma.componentBlockedQueue.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seVanStock.deleteMany({ where: { seId: SE_ID, componentId: sim } });
    await prisma.componentMaster.deleteMany({ where: { componentId: sim } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await app.close();
  });

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  }

  it('lists active blocked tickets for the ZM zone, flagging Warehouse Overdue past 7 days', async () => {
    const fresh = await makeBlockedTicket(new Date());
    const overdue = await makeBlockedTicket(new Date(Date.now() - 8 * 24 * 60 * 60 * 1000));

    const token = await login('zm.north@fsm.test');
    const res = await request(app.getHttpServer()).get('/api/component-blocked').set('Authorization', `Bearer ${token}`).expect(200);
    const rows = res.body as Array<{ ticketId: string; warehouseOverdue: boolean; missingComponents: unknown[] }>;
    expect(rows.find((r) => r.ticketId === fresh)?.warehouseOverdue).toBe(false);
    expect(rows.find((r) => r.ticketId === overdue)?.warehouseOverdue).toBe(true);
    expect((rows.find((r) => r.ticketId === fresh)?.missingComponents ?? []).length).toBe(1);
  });

  it('forbids an SE from the Component-Blocked Queue', async () => {
    const token = await login('se.north@fsm.test');
    await request(app.getHttpServer()).get('/api/component-blocked').set('Authorization', `Bearer ${token}`).expect(403);
  });

  it('returns the SE van stock + Common-Kit completeness', async () => {
    const token = await login('se.north@fsm.test');
    const res = await request(app.getHttpServer()).get('/api/me/van-stock').set('Authorization', `Bearer ${token}`).expect(200);
    expect(Array.isArray(res.body.stock)).toBe(true);
    expect(res.body.stock.some((s: { componentId: string }) => s.componentId === String(sim))).toBe(true);
    expect(typeof res.body.commonKit.complete).toBe('boolean');
  });
});
