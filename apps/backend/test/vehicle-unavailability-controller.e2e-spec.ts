import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 28 slice 3 — Vehicle Unavailability HTTP. A manager files a report; managers read the zone
 * list (with both SLA clocks); approve / override / history / resume-sla; an SE is gated out of the
 * manager list (so the secondary clock never reaches the SE). Service logic proven in
 * vehicle-unavailability-service and, for the #245 decision legs, vu-approval-lifecycle.
 */
const NS = Date.now();

describe('Issue 28 slice 3 — Vehicle Unavailability HTTP (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let plantId: bigint;
  let companyId: bigint;
  let deviceId: string;
  let ticketId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    companyId = (await prisma.company.create({ data: { name: 'Co-vuc-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-vuc-' + NS, zoneId: 1n } })).plantId;
    deviceId = String(9_700_000_000 + (NS % 100_000));
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: new Date('2026-06-25T10:00:00Z') } });
    const ticket = await prisma.ticket.create({
      data: { workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: cycle.cycleId, deviceId, plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: new Date('2026-06-25T10:00:00Z') },
    });
    ticketId = ticket.ticketId;
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { entityType: 'tickets', entityId: ticketId, action: 'VU_SLA_PAUSED' } });
    if (reportId) {
      await prisma.auditLog.deleteMany({ where: { entityType: 'vehicle_unavailability_reports', entityId: reportId } });
    }
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

  // #245 — the retired leg answers 410 rather than 404, so a stale client can tell "this endpoint is
  // gone" from "that id does not exist" and stop retrying.
  it('confirm-date is retired (410)', async () => {
    const token = await login('zm.north@fsm.test');
    const res = await request(app.getHttpServer())
      .post(`/api/vehicle-unavailability/${reportId}/confirm-date`)
      .set('Authorization', `Bearer ${token}`)
      .send({ expectedFrom: '2026-06-27T09:00:00Z' })
      .expect(410);
    expect(res.body.code).toBe('VU_CONFIRM_DATE_RETIRED');
  });

  it('override requires a reason (400), then approve/history/resume-sla (200)', async () => {
    const token = await login('zm.north@fsm.test');
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);

    await auth(request(app.getHttpServer()).post(`/api/vehicle-unavailability/${reportId}/override`))
      .send({ expectedFrom: '2026-06-27T09:00:00Z', reason: '  ' })
      .expect(400);

    await auth(request(app.getHttpServer()).post(`/api/vehicle-unavailability/${reportId}/approve`)).expect(200);

    const hist = await auth(request(app.getHttpServer()).get(`/api/vehicle-unavailability/${reportId}/history`)).expect(200);
    expect(hist.body.some((r: { id: string }) => r.id === reportId)).toBe(true);

    await auth(request(app.getHttpServer()).post(`/api/vehicle-unavailability/${reportId}/resume-sla`)).expect(200);

    // …and once it is resumed it is no longer the live report, so a further decision is a 409.
    await auth(request(app.getHttpServer()).post(`/api/vehicle-unavailability/${reportId}/approve`)).expect(409);
  });

  /**
   * #343 AC1 — the SLA clock stopping and restarting are the two events that decide whether a ticket
   * breached, and both were invisible: filing paused the primary clock and manual resume restarted it
   * with nothing in the ledger either way. A breach argued after the fact has to be reconstructible,
   * so each row carries whether the clock actually moved — `slaPaused` is false when the cycle was
   * already stopped for another reason (a component wait), and `slaResumed` is false when the pause
   * this report is resolving was not its own. Both are facts only the transaction knows.
   *
   * Runs after the resume leg above, so exactly one pause and one resume have happened on this ticket.
   */
  it('AC1 — filing writes VU_SLA_PAUSED on the ticket and manual resume writes VU_SLA_RESUMED_MANUAL on the report', async () => {
    const paused = await prisma.auditLog.findMany({
      where: { entityType: 'tickets', entityId: ticketId, action: 'VU_SLA_PAUSED' },
    });
    expect(paused).toHaveLength(1);
    expect(paused[0].actorRole).toBe('ZONAL_MANAGER');
    expect(paused[0].metadata).toMatchObject({ reasonCode: 'VEHICLE_ON_TRIP', reportId, slaPaused: true });

    const resumed = await prisma.auditLog.findMany({
      where: { entityType: 'vehicle_unavailability_reports', entityId: reportId, action: 'VU_SLA_RESUMED_MANUAL' },
    });
    expect(resumed).toHaveLength(1);
    expect(resumed[0].actorRole).toBe('ZONAL_MANAGER');
    expect(resumed[0].metadata).toMatchObject({ ticketId, slaResumed: true });
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

  // #171 — the per-report capture of what the SE actually dialed, distinct from the master
  // Transporter.contactPhone shown on Ticket Detail.
  it('#171 — captures transporterName/transporterContact on the report row', async () => {
    const token = await login('zm.north@fsm.test');
    const res = await request(app.getHttpServer())
      .post('/api/vehicle-unavailability')
      .set('Authorization', `Bearer ${token}`)
      .send({
        ticketId,
        seId: randomUUID(),
        reasonCode: 'VEHICLE_NOT_AT_PLANT',
        transporterName: 'Rapid Fleet',
        transporterContact: '+91-9000000000',
        expectedFrom: '2026-06-26T09:00:00Z',
      })
      .expect(201);

    const row = await prisma.vehicleUnavailabilityReport.findUniqueOrThrow({ where: { id: BigInt(res.body.id) } });
    expect(row.transporterName).toBe('Rapid Fleet');
    expect(row.transporterContact).toBe('+91-9000000000');
  });
});
