import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 24, slice 4 — the Shadow Use Queue HTTP surface (`/api/warehouse/shadow-use`). WAREHOUSE_MANAGER
 * lists + reconciles / disputes; other roles are forbidden; a dispute needs a mandatory reason.
 */
const NS = Date.now();
const SE_ID = '22222222-2222-2222-2222-222222222222';

describe('Shadow Use Queue HTTP surface (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let companyId: bigint;
  let plantId: bigint;
  let componentId: bigint;
  const deviceIds: bigint[] = [];
  const ticketIds: string[] = [];

  const seedShadow = async (): Promise<string> => {
    const deviceId = BigInt(12_900_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'SUBMITTED', openedAt: new Date() } });
    const ticket = await prisma.ticket.create({ data: { workType: 'TROUBLESHOOT', status: 'VERIFICATION_PENDING', failureCycleId: cycle.cycleId, deviceId, plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: new Date() } });
    ticketIds.push(ticket.ticketId);
    const txn = await prisma.inventoryTransaction.create({ data: { seId: SE_ID, componentId, qty: 1, ticketId: ticket.ticketId, type: 'TICKET_CONSUMPTION', status: 'SHADOW_USE' } });
    return String(txn.id);
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    await prisma.zone.upsert({ where: { zoneId: 1n }, create: { zoneId: 1n, name: 'Z1-' + NS }, update: {} });
    companyId = (await prisma.company.create({ data: { name: 'Co-suc-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-suc-' + NS, zoneId: 1n } })).plantId;
    componentId = (await prisma.componentMaster.create({ data: { name: 'cmp-suc-' + NS } })).componentId;
    await prisma.user.upsert({ where: { userId: SE_ID }, create: { userId: SE_ID, name: 'SE North', role: 'SERVICE_ENGINEER', phone: 'ph-suc-' + NS, email: `se-suc-${NS}@x.test`, zoneId: 1n }, update: {} });
    await prisma.engineerMaster.upsert({ where: { engineerId: SE_ID }, create: { engineerId: SE_ID, coverageType: 'DEDICATED', zoneId: 1n, dailyCapacity: 10 }, update: {} });
  });

  afterAll(async () => {
    await prisma.inventoryTransaction.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.auditLog.deleteMany({ where: { entityType: 'inventory_transactions' } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
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

  it('lets the WM list + reconcile; forbids an SE; requires a dispute reason', async () => {
    const id = await seedShadow();
    const wm = await login('wm@fsm.test');
    const list = await request(app.getHttpServer()).get('/api/warehouse/shadow-use').set('Authorization', `Bearer ${wm}`).expect(200);
    expect((list.body as Array<{ id: string }>).some((r) => r.id === id)).toBe(true);

    const se = await login('se.north@fsm.test');
    await request(app.getHttpServer()).get('/api/warehouse/shadow-use').set('Authorization', `Bearer ${se}`).expect(403);

    // dispute without reason → 400; with reason → 201
    const id2 = await seedShadow();
    await request(app.getHttpServer()).post(`/api/warehouse/shadow-use/${id2}/dispute`).set('Authorization', `Bearer ${wm}`).send({}).expect(400);
    await request(app.getHttpServer()).post(`/api/warehouse/shadow-use/${id2}/dispute`).set('Authorization', `Bearer ${wm}`).send({ reason: 'mismatch' }).expect(201);

    await request(app.getHttpServer()).post(`/api/warehouse/shadow-use/${id}/reconcile`).set('Authorization', `Bearer ${wm}`).expect(201);
    // reconciling again → 409 (no longer SHADOW_USE)
    await request(app.getHttpServer()).post(`/api/warehouse/shadow-use/${id}/reconcile`).set('Authorization', `Bearer ${wm}`).expect(409);
  });
});
