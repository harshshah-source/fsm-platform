import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 36, slice 3 — Recovery HTTP surface (`/api/recovery`). Full field workflow over HTTP: a
 * manager schedules to the SE, the assigned SE marks on-site + collected, the Warehouse Manager
 * confirms receipt (auto-close). Role gating + the Collection-Form validation are enforced.
 */
const DEV = 9_362_001n;

describe('Issue 36 slice 3 — /api/recovery (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let seId: string;

  const newTicket = async () =>
    (await prisma.ticket.create({ data: { workType: 'RECOVERY', status: 'REQUESTED', deviceId: DEV, plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: new Date() } })).ticketId;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
    zoneId = (await prisma.zone.create({ data: { name: 'Z-recc-' + Date.now() } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-recc-' + Date.now(), companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-recc', zoneId } })).plantId;
    await prisma.device.create({ data: { deviceId: DEV, dealType: 'RECURRING' } });
  });

  afterAll(async () => {
    await prisma.ticketEvent.deleteMany({ where: { ticket: { deviceId: DEV } } });
    await prisma.ticket.deleteMany({ where: { deviceId: DEV } });
    await prisma.device.deleteMany({ where: { deviceId: DEV } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await app.close();
  });

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  };
  const me = async (token: string): Promise<string> => {
    const res = await request(app.getHttpServer()).get('/api/me').set('Authorization', `Bearer ${token}`).expect(200);
    return res.body.user_id as string;
  };

  it('schedule → on-site → collected → receipt auto-closes over HTTP', async () => {
    const zm = await login('zm.north@fsm.test');
    const seToken = await login('se.north@fsm.test');
    const wm = await login('wm@fsm.test');
    seId = await me(seToken);
    const id = await newTicket();

    await request(app.getHttpServer()).post(`/api/recovery/${id}/schedule`).set('Authorization', `Bearer ${zm}`).send({ seId }).expect(200);
    await request(app.getHttpServer()).post(`/api/recovery/${id}/on-site`).set('Authorization', `Bearer ${seToken}`).expect(200);

    // serial must match the device id; notes mandatory
    await request(app.getHttpServer()).post(`/api/recovery/${id}/collected`).set('Authorization', `Bearer ${seToken}`).send({ deviceSerial: '123', conditionNotes: 'x' }).expect(400);
    await request(app.getHttpServer()).post(`/api/recovery/${id}/collected`).set('Authorization', `Bearer ${seToken}`).send({ deviceSerial: String(DEV), conditionNotes: 'fine' }).expect(200);

    const closed = await request(app.getHttpServer()).post(`/api/recovery/${id}/receipt`).set('Authorization', `Bearer ${wm}`).expect(200);
    expect(closed.body.status).toBe('CLOSED');
    expect(closed.body.closureType).toBe('AUTO_CLOSED_ON_WAREHOUSE_RECEIPT');
    expect(closed.body.deviceId).toBe(String(DEV));
  });

  it('enforces role gating: a ZM cannot mark on-site; an SE cannot confirm receipt', async () => {
    const zm = await login('zm.north@fsm.test');
    const seToken = await login('se.north@fsm.test');
    const id = await newTicket();
    await request(app.getHttpServer()).post(`/api/recovery/${id}/schedule`).set('Authorization', `Bearer ${zm}`).send({ seId }).expect(200);
    await request(app.getHttpServer()).post(`/api/recovery/${id}/on-site`).set('Authorization', `Bearer ${zm}`).expect(403);
    await request(app.getHttpServer()).post(`/api/recovery/${id}/receipt`).set('Authorization', `Bearer ${seToken}`).expect(403);
  });
});
