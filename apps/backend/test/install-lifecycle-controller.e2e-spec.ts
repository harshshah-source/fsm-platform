import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 34 — Install lifecycle HTTP surface (`/api/install/:id/*`). A manager schedules a REQUESTED
 * install to the seeded SE; the assigned SE marks on-site and submits the Install Form (GPS + SIM
 * serial) → ACTIVATED; the Warehouse Manager reads the ticket and sees the GPS + SIM serials (AC#5).
 * Seeded actors: `zm.north` (ZM zone 1), `se.north` (SE id 2222…, zone 1), `wm` (Warehouse Manager).
 */
const SE_NORTH_ID = '22222222-2222-2222-2222-222222222222';
const DEV = 9_344_900n;

describe('Issue 34 — /api/install/:id lifecycle (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let zone1: bigint;
  let companyId: bigint;
  let plant1: bigint;
  let vehicleId: bigint;
  let ticketId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    const stamp = Date.now();
    zone1 = (await prisma.zone.upsert({ where: { zoneId: 1n }, update: {}, create: { zoneId: 1n, name: 'Zone-1-seed' } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-ilc-' + stamp, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plant1 = (await prisma.plant.create({ data: { name: 'P-ilc-' + stamp, zoneId: zone1 } })).plantId;
    vehicleId = (await prisma.vehicle.create({ data: { vehicleNo: 'ILC-' + stamp, plantId: plant1, companyId } })).vehicleId;
    await prisma.device.create({ data: { deviceId: DEV, deviceType: 'GPS-X' } });
    ticketId = (await prisma.ticket.create({
      data: {
        workType: 'INSTALL', status: 'REQUESTED', deviceId: DEV, vehicleId, plantId: plant1, companyId,
        companyTier: 'GOLD', installTriggerSource: 'MANUAL_OPERATIONS', lastStateChangedAt: new Date(),
      },
    })).ticketId;
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { entityType: 'tickets', entityId: ticketId } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId } });
    await prisma.ticket.deleteMany({ where: { ticketId } });
    await prisma.device.deleteMany({ where: { deviceId: DEV } });
    await prisma.vehicle.deleteMany({ where: { vehicleId } });
    await prisma.plant.deleteMany({ where: { plantId: plant1 } });
    await prisma.company.deleteMany({ where: { companyId } });
    await app.close();
  });

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  };

  it('forbids a Service Engineer from scheduling (403)', async () => {
    const se = await login('se.north@fsm.test');
    await request(app.getHttpServer())
      .post(`/api/install/${ticketId}/schedule`)
      .set('Authorization', `Bearer ${se}`)
      .send({ seId: SE_NORTH_ID })
      .expect(403);
  });

  it('drives the full lifecycle: ZM schedule → SE on-site → SE fitted (ACTIVATED)', async () => {
    const zm = await login('zm.north@fsm.test');
    const sched = await request(app.getHttpServer())
      .post(`/api/install/${ticketId}/schedule`)
      .set('Authorization', `Bearer ${zm}`)
      .send({ seId: SE_NORTH_ID })
      .expect(200);
    expect(sched.body.status).toBe('SCHEDULED');
    expect(sched.body.assignedSeId).toBe(SE_NORTH_ID);

    const se = await login('se.north@fsm.test');
    const onsite = await request(app.getHttpServer())
      .post(`/api/install/${ticketId}/on-site`)
      .set('Authorization', `Bearer ${se}`)
      .expect(200);
    expect(onsite.body.status).toBe('ON_SITE');

    // missing SIM serial → 400
    await request(app.getHttpServer())
      .post(`/api/install/${ticketId}/fitted`)
      .set('Authorization', `Bearer ${se}`)
      .send({ gpsDeviceSerial: String(DEV), simSerial: '' })
      .expect(400);

    const fitted = await request(app.getHttpServer())
      .post(`/api/install/${ticketId}/fitted`)
      .set('Authorization', `Bearer ${se}`)
      .send({ gpsDeviceSerial: String(DEV), simSerial: 'SIM-ILC', photoRef: 'p/ilc.jpg' })
      .expect(200);
    expect(fitted.body.status).toBe('ACTIVATED');
    expect(fitted.body.fittedSimSerial).toBe('SIM-ILC');
  });

  it('Warehouse Manager reads the Install Ticket and sees GPS + SIM serials (AC#5)', async () => {
    const wm = await login('wm@fsm.test');
    const res = await request(app.getHttpServer())
      .get(`/api/install/${ticketId}`)
      .set('Authorization', `Bearer ${wm}`)
      .expect(200);
    expect(res.body.fittedGpsSerial).toBe(String(DEV));
    expect(res.body.fittedSimSerial).toBe('SIM-ILC');
    expect(res.body.deviceId).toBe(String(DEV));
  });

  it('rejects a wrong-state transition (scheduling an ACTIVATED ticket) with 409', async () => {
    const zm = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .post(`/api/install/${ticketId}/schedule`)
      .set('Authorization', `Bearer ${zm}`)
      .send({ seId: SE_NORTH_ID })
      .expect(409);
  });
});
