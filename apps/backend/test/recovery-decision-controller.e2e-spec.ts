import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 37, slice 3 — ZM decision-queue + closure HTTP surface (`/api/recovery`). A ZM reschedules,
 * closes FAILED_RECOVERY, escalates, or manually closes an unable-to-collect recovery ticket; an SE
 * is forbidden. Manual close records the closure type by acting role.
 */
const DEV = 9_372_001n;

describe('Issue 37 slice 3 — /api/recovery decision-queue (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let seId: string;

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  };
  const me = async (token: string): Promise<string> => {
    const res = await request(app.getHttpServer()).get('/api/me').set('Authorization', `Bearer ${token}`).expect(200);
    return res.body.user_id as string;
  };

  /** Create + drive a recovery ticket to the unable-to-collect decision queue over HTTP. */
  const unableTicket = async (zm: string, seToken: string) => {
    const id = (await prisma.ticket.create({ data: { workType: 'RECOVERY', status: 'REQUESTED', deviceId: DEV, plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: new Date() } })).ticketId;
    await request(app.getHttpServer()).post(`/api/recovery/${id}/schedule`).set('Authorization', `Bearer ${zm}`).send({ seId }).expect(200);
    await request(app.getHttpServer()).post(`/api/recovery/${id}/on-site`).set('Authorization', `Bearer ${seToken}`).expect(200);
    await request(app.getHttpServer()).post(`/api/recovery/${id}/unable-to-collect`).set('Authorization', `Bearer ${seToken}`).send({ reasonCode: 'COMPANY_REFUSED' }).expect(200);
    return id;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
    zoneId = (await prisma.zone.create({ data: { name: 'Z-recdc-' + Date.now() } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-recdc-' + Date.now(), companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-recdc', zoneId } })).plantId;
    await prisma.device.create({ data: { deviceId: DEV, dealType: 'RECURRING' } });
    seId = await me(await login('se.north@fsm.test'));
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { entityType: 'tickets', entityId: { contains: '-' } } });
    await prisma.ticketEvent.deleteMany({ where: { ticket: { deviceId: DEV } } });
    await prisma.ticket.deleteMany({ where: { deviceId: DEV } });
    await prisma.device.deleteMany({ where: { deviceId: DEV } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await app.close();
  });

  it('ZM closes FAILED_RECOVERY (reason required); the queue read reflects it', async () => {
    const zm = await login('zm.north@fsm.test');
    const seToken = await login('se.north@fsm.test');
    const id = await unableTicket(zm, seToken);

    const queue = await request(app.getHttpServer()).get('/api/recovery/zm-queue').set('Authorization', `Bearer ${zm}`).expect(200);
    expect(queue.body.some((r: { ticketId: string }) => r.ticketId === id)).toBe(true);

    await request(app.getHttpServer()).post(`/api/recovery/${id}/close-failed`).set('Authorization', `Bearer ${zm}`).send({ reason: '' }).expect(400);
    const closed = await request(app.getHttpServer()).post(`/api/recovery/${id}/close-failed`).set('Authorization', `Bearer ${zm}`).send({ reason: 'scrapped' }).expect(200);
    expect(closed.body.status).toBe('FAILED_RECOVERY');
    expect(closed.body.closureType).toBe('FAILED_RECOVERY_CLOSE');
  });

  it('Operations Head manual-close records OPERATIONS_HEAD_OVERRIDE_CLOSE', async () => {
    const zm = await login('zm.north@fsm.test');
    const seToken = await login('se.north@fsm.test');
    const oh = await login('ops.head@fsm.test');
    const id = await unableTicket(zm, seToken);
    const closed = await request(app.getHttpServer()).post(`/api/recovery/${id}/manual-close`).set('Authorization', `Bearer ${oh}`).send({ reason: 'override' }).expect(200);
    expect(closed.body.closureType).toBe('OPERATIONS_HEAD_OVERRIDE_CLOSE');
  });

  it('forbids a Service Engineer from decision-queue actions', async () => {
    const zm = await login('zm.north@fsm.test');
    const seToken = await login('se.north@fsm.test');
    const id = await unableTicket(zm, seToken);
    await request(app.getHttpServer()).post(`/api/recovery/${id}/reschedule`).set('Authorization', `Bearer ${seToken}`).send({ seId }).expect(403);
    await request(app.getHttpServer()).post(`/api/recovery/${id}/manual-close`).set('Authorization', `Bearer ${seToken}`).send({ reason: 'x' }).expect(403);
  });
});
