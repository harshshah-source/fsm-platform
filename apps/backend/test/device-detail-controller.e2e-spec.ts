import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 44 slice 4 — `/api/devices/:id/cycles` + `/api/devices/:id/downtime-trend`. The Device Detail
 * per-cycle list and the Lifetime Downtime Trend, accessible to ZM (own zone), CSM, and Operations Head.
 * A ZM in another zone gets 404 (no existence leak); a Service Engineer is forbidden. Seeded: a device in
 * zone 1 with one closed failure cycle.
 */
const NS = Date.now();

describe('Issue 44 slice 4 — device detail endpoints (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let companyId: bigint;
  let plantId: bigint;
  let deviceId: bigint;
  const cycleIds: string[] = [];
  const ticketIds: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    await prisma.zone.upsert({ where: { zoneId: 1n }, update: {}, create: { zoneId: 1n, name: 'Zone-1-seed' } });
    companyId = (await prisma.company.create({ data: { name: 'Co-ddc-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-ddc-' + NS, zoneId: 1n } })).plantId;
    deviceId = BigInt(9_447_000_000 + (NS % 100_000));
    await prisma.device.create({ data: { deviceId, deviceType: 'GPS-X' } });
    await prisma.deviceState.create({ data: { deviceId, eligibleForUptime: true, plantId, companyId, computedAt: new Date() } });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'VERIFIED', openedAt: new Date(Date.UTC(2026, 4, 5)), closedAt: new Date(Date.UTC(2026, 4, 6)) } });
    cycleIds.push(cycle.cycleId);
    const ticket = await prisma.ticket.create({ data: { workType: 'TROUBLESHOOT', status: 'CLOSED', failureCycleId: cycle.cycleId, deviceId, plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: new Date() } });
    ticketIds.push(ticket.ticketId);
  });

  afterAll(async () => {
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { cycleId: { in: cycleIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId } });
    await prisma.device.deleteMany({ where: { deviceId } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await app.close();
  });

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  };

  it('Operations Head reads the device cycles and the downtime trend', async () => {
    const oh = await login('ops.head@fsm.test');
    const cycles = await request(app.getHttpServer()).get(`/api/devices/${deviceId}/cycles`).set('Authorization', `Bearer ${oh}`).expect(200);
    expect(cycles.body.cycles).toHaveLength(1);
    expect(cycles.body.cycles[0].durationSeconds).toBe(86_400);

    const trend = await request(app.getHttpServer()).get(`/api/devices/${deviceId}/downtime-trend`).set('Authorization', `Bearer ${oh}`).expect(200);
    expect(trend.body.deviceId).toBe(String(deviceId));
    expect(Array.isArray(trend.body.monthly)).toBe(true);
  });

  it('a ZM in the device’s zone (zone 1) can read it', async () => {
    const zm = await login('zm.north@fsm.test');
    await request(app.getHttpServer()).get(`/api/devices/${deviceId}/cycles`).set('Authorization', `Bearer ${zm}`).expect(200);
  });

  it('forbids a Service Engineer (403)', async () => {
    const se = await login('se.north@fsm.test');
    await request(app.getHttpServer()).get(`/api/devices/${deviceId}/cycles`).set('Authorization', `Bearer ${se}`).expect(403);
  });

  it('an unknown device is 404', async () => {
    const oh = await login('ops.head@fsm.test');
    await request(app.getHttpServer()).get('/api/devices/999999999999/cycles').set('Authorization', `Bearer ${oh}`).expect(404);
  });

  it('rejects a non-numeric device id (400)', async () => {
    const oh = await login('ops.head@fsm.test');
    await request(app.getHttpServer()).get('/api/devices/abc/cycles').set('Authorization', `Bearer ${oh}`).expect(400);
  });
});
