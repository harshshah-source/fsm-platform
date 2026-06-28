import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 03 slice 4 — `/api/audit-trail/tickets/:id`. Merges a Ticket's `ticket_events` (state transitions)
 * with its `audit_logs` actions into one time-ordered chain showing actor, role, and `acted_as_role`
 * (AC#5/#6). Manager roles only; a ZM sees only tickets in their own zone (out-of-zone → 404).
 */
const NS = Date.now();
const NOW = new Date('2026-06-27T08:00:00Z');
const ZM_NORTH = '11111111-1111-1111-1111-111111111111';

describe('Issue 03 slice 4 — /api/audit-trail/tickets/:id (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let otherZone: bigint;
  let companyId: bigint;
  let otherPlant: bigint;
  let zone1Plant: bigint;
  let otherTicket: string;
  let zone1Ticket: string;
  const deviceIds: bigint[] = [];
  const cycleIds: string[] = [];
  const ticketIds: string[] = [];
  const auditIds: bigint[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    await prisma.zone.upsert({ where: { zoneId: 1n }, update: {}, create: { zoneId: 1n, name: 'Zone-1-seed' } });
    otherZone = (await prisma.zone.create({ data: { name: 'Z-at-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-at-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    otherPlant = (await prisma.plant.create({ data: { name: 'P-at-o-' + NS, zoneId: otherZone } })).plantId;
    zone1Plant = (await prisma.plant.create({ data: { name: 'P-at-1-' + NS, zoneId: 1n } })).plantId;

    otherTicket = await makeTicket(otherPlant);
    zone1Ticket = await makeTicket(zone1Plant);

    // A small transition chain + an audited action on the other-zone ticket.
    await prisma.ticketEvent.create({ data: { ticketId: otherTicket, fromState: null, toState: 'OPEN', actorId: null, actorRole: 'SERVICE_ENGINEER', at: new Date(NOW.getTime() - 3_600_000) } });
    await prisma.ticketEvent.create({ data: { ticketId: otherTicket, fromState: 'OPEN', toState: 'CLOSED', actorId: ZM_NORTH, actorRole: 'CENTRAL_SERVICE_MANAGER', actedAsRole: 'ZONAL_MANAGER', reasonCode: 'RESOLVED', at: NOW } });
    const a = await prisma.auditLog.create({ data: { actorId: ZM_NORTH, actorRole: 'ZONAL_MANAGER', actedAsRole: 'ZONAL_MANAGER', actingZone: otherZone, action: 'CRITICAL_ASSIGN', entityType: 'ticket', entityId: otherTicket, createdAt: new Date(NOW.getTime() - 1_800_000) } });
    auditIds.push(a.id);
  });

  async function makeTicket(plant: bigint): Promise<string> {
    const deviceId = BigInt(9_030_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
    cycleIds.push(cycle.cycleId);
    const t = await prisma.ticket.create({ data: { workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: cycle.cycleId, deviceId, plantId: plant, companyId, companyTier: 'GOLD', lastStateChangedAt: NOW } });
    ticketIds.push(t.ticketId);
    return t.ticketId;
  }

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { id: { in: auditIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { cycleId: { in: cycleIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [otherPlant, zone1Plant] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId: otherZone } });
    await app.close();
  });

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  };

  it('Operations Head sees the merged, time-ordered trail with actor/role/acted_as_role', async () => {
    const oh = await login('ops.head@fsm.test');
    const res = await request(app.getHttpServer()).get(`/api/audit-trail/tickets/${otherTicket}`).set('Authorization', `Bearer ${oh}`).expect(200);
    const e = res.body.entries;
    expect(e).toHaveLength(3);
    expect(e.map((x: { kind: string }) => x.kind)).toEqual(['STATE_CHANGE', 'ACTION', 'STATE_CHANGE']); // ordered by time
    expect(e[1].action).toBe('CRITICAL_ASSIGN');
    const closed = e[2];
    expect(closed.toState).toBe('CLOSED');
    expect(closed.reasonCode).toBe('RESOLVED');
    expect(closed.actedAsRole).toBe('ZONAL_MANAGER'); // AC#6
  });

  it('a ZM sees a trail for a ticket in their own zone (zone 1)', async () => {
    const zm = await login('zm.north@fsm.test');
    await request(app.getHttpServer()).get(`/api/audit-trail/tickets/${zone1Ticket}`).set('Authorization', `Bearer ${zm}`).expect(200);
  });

  it('a ZM is denied a ticket in another zone (404)', async () => {
    const zm = await login('zm.north@fsm.test');
    await request(app.getHttpServer()).get(`/api/audit-trail/tickets/${otherTicket}`).set('Authorization', `Bearer ${zm}`).expect(404);
  });

  it('forbids a Service Engineer (403)', async () => {
    const se = await login('se.north@fsm.test');
    await request(app.getHttpServer()).get(`/api/audit-trail/tickets/${zone1Ticket}`).set('Authorization', `Bearer ${se}`).expect(403);
  });

  it('unknown ticket → 404, malformed id → 400', async () => {
    const oh = await login('ops.head@fsm.test');
    await request(app.getHttpServer()).get(`/api/audit-trail/tickets/${randomUUID()}`).set('Authorization', `Bearer ${oh}`).expect(404);
    await request(app.getHttpServer()).get('/api/audit-trail/tickets/not-a-uuid').set('Authorization', `Bearer ${oh}`).expect(400);
  });
});
