import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { SHARED_AUTH_SE_ID, ensureSharedAuthSe } from './fixtures/shared-auth-se';

/**
 * Issue 24, slice 4 — the Shadow Use Queue HTTP surface (`/api/warehouse/shadow-use`). WAREHOUSE_MANAGER
 * lists + reconciles / disputes; other roles are forbidden; a dispute needs a mandatory reason.
 */
const NS = Date.now();
const SE_ID = SHARED_AUTH_SE_ID; // se.north@fsm.test — shared across 16 specs, see fixtures/shared-auth-se.ts

describe('Shadow Use Queue HTTP surface (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let companyId: bigint;
  let plantId: bigint;
  let componentId: bigint;
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];

  const seedShadow = async (): Promise<string> => {
    const deviceId = String(12_900_000_000 + (NS % 100_000) * 10 + deviceIds.length);
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
    await ensureSharedAuthSe(prisma, { zoneId: 1n, tag: `suc-${NS}` });
  });

  afterAll(async () => {
    await prisma.seVanStock.deleteMany({ where: { componentId } });
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

  /**
   * #353 AC3/AC4 — the ZM a dispute escalates TO can now read the disputes in their own zone, and
   * still cannot take a Warehouse Manager's action on one. The read is the new door; the write guard
   * is deliberately untouched.
   */
  it('lets a ZM read own-zone disputes and still refuses every WM write', async () => {
    const id = await seedShadow();
    const wm = await login('wm@fsm.test');
    await request(app.getHttpServer())
      .post(`/api/warehouse/shadow-use/${id}/dispute`)
      .set('Authorization', `Bearer ${wm}`)
      .send({ reason: 'the winner reported this part' })
      .expect(201);

    const zm = await login('zm.north@fsm.test'); // zone 1 — the zone this spec seeds into
    const list = await request(app.getHttpServer())
      .get('/api/warehouse/shadow-use?status=DISPUTED')
      .set('Authorization', `Bearer ${zm}`)
      .expect(200);
    const row = (list.body as Array<{ id: string; reason: string | null; escalatedTo: string | null }>).find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(row!.reason).toBe('the winner reported this part');
    expect(row!.escalatedTo).toBe('ZONAL_MANAGER');

    // AC4 — the WM guard is unchanged.
    const other = await seedShadow();
    await request(app.getHttpServer()).post(`/api/warehouse/shadow-use/${other}/reconcile`).set('Authorization', `Bearer ${zm}`).expect(403);
    await request(app.getHttpServer()).post(`/api/warehouse/shadow-use/${other}/dispute`).set('Authorization', `Bearer ${zm}`).send({ reason: 'x' }).expect(403);
    const se = await login('se.north@fsm.test');
    await request(app.getHttpServer()).get('/api/warehouse/shadow-use?status=DISPUTED').set('Authorization', `Bearer ${se}`).expect(403);
  });

  it('rejects an unknown status filter rather than silently listing everything', async () => {
    const wm = await login('wm@fsm.test');
    await request(app.getHttpServer()).get('/api/warehouse/shadow-use?status=NONSENSE').set('Authorization', `Bearer ${wm}`).expect(400);
  });
});
