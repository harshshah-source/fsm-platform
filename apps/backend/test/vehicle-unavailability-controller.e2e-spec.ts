import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 28 slice 3 — Vehicle Unavailability HTTP. A manager files a report; managers read the zone
 * list (with both SLA clocks); confirm-date + resume-sla; an SE is gated out of the manager list
 * (so the secondary clock never reaches the SE). Service logic proven in vehicle-unavailability-service.
 */
const NS = Date.now();

describe('Issue 28 slice 3 — Vehicle Unavailability HTTP (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let plantId: bigint;
  let companyId: bigint;
  let deviceId: bigint;
  let ticketId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    companyId = (await prisma.company.create({ data: { name: 'Co-vuc-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-vuc-' + NS, zoneId: 1n } })).plantId;
    deviceId = BigInt(9_700_000_000 + (NS % 100_000));
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: new Date('2026-06-25T10:00:00Z') } });
    const ticket = await prisma.ticket.create({
      data: { workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: cycle.cycleId, deviceId, plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: new Date('2026-06-25T10:00:00Z') },
    });
    ticketId = ticket.ticketId;
  });

  afterAll(async () => {
    await prisma.vehicleUnavailabilityReport.deleteMany({ where: { ticketId } });
    await prisma.ticket.deleteMany({ where: { ticketId } });
    await prisma.failureCycle.deleteMany({ where: { deviceId } });
    await prisma.device.deleteMany({ where: { deviceId } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await app.close();
  });

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  };

  let reportId: string;

  it('a manager files a report (201) pausing the SLA', async () => {
    const token = await login('zm.north@fsm.test');
    const res = await request(app.getHttpServer())
      .post('/api/vehicle-unavailability')
      .set('Authorization', `Bearer ${token}`)
      .send({ ticketId, seId: randomUUID(), reasonCode: 'VEHICLE_ON_TRIP', transporterContacted: true, expectedFrom: '2026-06-26T09:00:00Z', notes: 'trip' })
      .expect(201);
    expect(res.body.result).toBe('OK');
    reportId = res.body.id;
  });

  it('a manager reads the zone list with both SLA clocks (200)', async () => {
    const token = await login('zm.north@fsm.test');
    const res = await request(app.getHttpServer()).get('/api/vehicle-unavailability').set('Authorization', `Bearer ${token}`).expect(200);
    const row = res.body.find((r: { ticketId: string }) => r.ticketId === ticketId);
    expect(row).toBeDefined();
    expect(typeof row.secondarySlaSeconds).toBe('number');
    expect(typeof row.primarySlaSeconds).toBe('number');
  });

  it('confirm-date and resume-sla (200)', async () => {
    const token = await login('zm.north@fsm.test');
    await request(app.getHttpServer()).post(`/api/vehicle-unavailability/${reportId}/confirm-date`).set('Authorization', `Bearer ${token}`).send({ expectedFrom: '2026-06-27T09:00:00Z' }).expect(200);
    await request(app.getHttpServer()).post(`/api/vehicle-unavailability/${reportId}/resume-sla`).set('Authorization', `Bearer ${token}`).expect(200);
  });

  it('forbids an SE from the manager list (403, secondary clock never reaches SE) and rejects bad reason (400)', async () => {
    const seToken = await login('se.north@fsm.test');
    await request(app.getHttpServer()).get('/api/vehicle-unavailability').set('Authorization', `Bearer ${seToken}`).expect(403);
    const zmToken = await login('zm.north@fsm.test');
    await request(app.getHttpServer())
      .post('/api/vehicle-unavailability')
      .set('Authorization', `Bearer ${zmToken}`)
      .send({ ticketId, seId: randomUUID(), reasonCode: 'NOPE', expectedFrom: '2026-06-26T09:00:00Z' })
      .expect(400);
  });
});
