import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * #342 — `GET /api/audit-trail` (the audit ledger search).
 *
 * Before this slice the only audit read was `/audit-trail/tickets/:id`, so answering "who did what,
 * in whose scope, when" required already knowing a ticket UUID. These tests pin the two properties
 * that make the ledger trustworthy rather than merely present:
 *
 *  - **AC1 — the filters are real.** Every filter assertion here compares row-id *sets*, not counts,
 *    and one test asserts two different filters return different bodies. A search endpoint that
 *    ignored its query string would pass a count-only test.
 *  - **AC2 — the ZM clamp.** A row's zone is `acting_zone` ▸ the entity's zone (for a ticket row)
 *    ▸ the actor's home zone. The fixture below carries one row of each kind in the ZM's zone and
 *    one of each kind outside it, so a clamp that only checked `acting_zone` would fail.
 *  - **AC5 — keyset pagination**, `limit ≤ 200`.
 */
const NS = Date.now();
const ET = `t342_${NS}`; // entity_type unique to this file — every assertion scopes to it
const BASE = new Date('2026-07-01T10:00:00Z');

describe('#342 — GET /api/audit-trail (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let zmUserId: string;
  let ohUserId: string;
  let otherZone: bigint;
  let companyId: bigint;
  let zone1Plant: bigint;
  let otherPlant: bigint;
  let zone1Ticket: string;
  let otherTicket: string;

  const auditIds: bigint[] = [];
  const ticketIds: string[] = [];
  const cycleIds: string[] = [];
  const deviceIds: string[] = [];

  /** id of each seeded row, by the name used in the assertions below. */
  const row: Record<string, string> = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    zmUserId = (await prisma.user.findUniqueOrThrow({ where: { email: 'zm.north@fsm.test' } })).userId;
    ohUserId = (await prisma.user.findUniqueOrThrow({ where: { email: 'ops.head@fsm.test' } })).userId;

    await prisma.zone.upsert({ where: { zoneId: 1n }, update: {}, create: { zoneId: 1n, name: 'Zone-1-seed' } });
    otherZone = (await prisma.zone.create({ data: { name: `Z-342-${NS}` } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: `Co-342-${NS}`, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    zone1Plant = (await prisma.plant.create({ data: { name: `P-342-1-${NS}`, zoneId: 1n } })).plantId;
    otherPlant = (await prisma.plant.create({ data: { name: `P-342-o-${NS}`, zoneId: otherZone } })).plantId;
    zone1Ticket = await makeTicket(zone1Plant);
    otherTicket = await makeTicket(otherPlant);

    // Six rows, one per way a row can (or cannot) belong to a zone.
    row.actingHere = await audit({
      actorId: ohUserId, actorRole: 'OPERATIONS_HEAD', actedAsRole: 'ZONAL_MANAGER', actingZone: 1n,
      action: 'BATCH_APPROVED', entityType: ET, entityId: `acting-here-${NS}`, at: 5,
      metadata: { previous: 'HOLD', next: 'APPROVED', reason: 'covering north' },
    });
    row.actingThere = await audit({
      actorId: ohUserId, actorRole: 'OPERATIONS_HEAD', actedAsRole: 'ZONAL_MANAGER', actingZone: otherZone,
      action: 'BATCH_APPROVED', entityType: ET, entityId: `acting-there-${NS}`, at: 4,
    });
    row.ticketHere = await audit({
      actorId: ohUserId, actorRole: 'OPERATIONS_HEAD', actedAsRole: null, actingZone: null,
      action: 'CRITICAL_ASSIGN', entityType: 'ticket', entityId: zone1Ticket, at: 3,
      metadata: { seId: 'se-1' },
    });
    row.ticketThere = await audit({
      actorId: ohUserId, actorRole: 'OPERATIONS_HEAD', actedAsRole: null, actingZone: null,
      action: 'CRITICAL_ASSIGN', entityType: 'tickets', entityId: otherTicket, at: 2,
    });
    row.byZmHome = await audit({
      actorId: zmUserId, actorRole: 'ZONAL_MANAGER', actedAsRole: null, actingZone: null,
      action: 'SETTING_UPDATED', entityType: ET, entityId: `zm-home-${NS}`, at: 1,
    });
    row.panIndia = await audit({
      actorId: ohUserId, actorRole: 'OPERATIONS_HEAD', actedAsRole: null, actingZone: null,
      action: 'SETTING_UPDATED', entityType: ET, entityId: `pan-india-${NS}`, at: 0,
    });
  });

  async function makeTicket(plant: bigint): Promise<string> {
    const deviceId = String(9_042_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: BASE } });
    cycleIds.push(cycle.cycleId);
    const t = await prisma.ticket.create({
      data: { workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: cycle.cycleId, deviceId, plantId: plant, companyId, companyTier: 'GOLD', lastStateChangedAt: BASE },
    });
    ticketIds.push(t.ticketId);
    return t.ticketId;
  }

  /** `at` is minutes after {@link BASE}, so the seeded rows have a deterministic newest-first order. */
  async function audit(d: {
    actorId: string; actorRole: string; actedAsRole: string | null; actingZone: bigint | null;
    action: string; entityType: string; entityId: string; at: number; metadata?: object;
  }): Promise<string> {
    const created = await prisma.auditLog.create({
      data: {
        actorId: d.actorId, actorRole: d.actorRole, actedAsRole: d.actedAsRole, actingZone: d.actingZone,
        action: d.action, entityType: d.entityType, entityId: d.entityId,
        metadata: d.metadata ?? undefined,
        createdAt: new Date(BASE.getTime() + d.at * 60_000),
      },
    });
    auditIds.push(created.id);
    return String(created.id);
  }

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { id: { in: auditIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { cycleId: { in: cycleIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [zone1Plant, otherPlant] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId: otherZone } });
    await app.close();
  });

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'correct-password' }).expect(200);
    return res.body.accessToken as string;
  };

  interface LedgerRow { id: string; action: string; entityType: string; entityId: string; zoneId: number | null; actorId: string; actedAsRole: string | null }
  const get = async (token: string, qs: string, status = 200) =>
    request(app.getHttpServer()).get(`/api/audit-trail${qs}`).set('Authorization', `Bearer ${token}`).expect(status);
  const ids = (body: { rows: LedgerRow[] }) => body.rows.map((r) => r.id);

  it('lists the ledger newest-first for an Operations Head, with the resolved zone on every row', async () => {
    const oh = await login('ops.head@fsm.test');
    const res = await get(oh, `?entityType=${ET}`);
    expect(ids(res.body)).toEqual([row.actingHere, row.actingThere, row.byZmHome, row.panIndia]);
    const byId = Object.fromEntries((res.body.rows as LedgerRow[]).map((r) => [r.id, r]));
    expect(byId[row.actingHere].zoneId).toBe(1);
    expect(byId[row.actingThere].zoneId).toBe(Number(otherZone));
    expect(byId[row.byZmHome].zoneId).toBe(1); // actor's home zone
    expect(byId[row.panIndia].zoneId).toBeNull(); // pan-India action, no zone
  });

  it('AC2 — a ZM sees only their own zone: acted-in rows, their own rows, and rows on their tickets', async () => {
    const zm = await login('zm.north@fsm.test');
    const res = await get(zm, `?entityType=${ET}`);
    expect(ids(res.body).sort()).toEqual([row.actingHere, row.byZmHome].sort());

    // …and the ticket rows resolve through the ticket's plant zone, not the actor's.
    const tickets = await get(zm, '?entityType=ticket');
    expect(ids(tickets.body)).toContain(row.ticketHere);
    expect(ids(tickets.body)).not.toContain(row.ticketThere);
  });

  it('AC1 — action, actorUserId, actedAsRole, entityId and zoneId each change the result', async () => {
    const oh = await login('ops.head@fsm.test');
    const all = await get(oh, `?entityType=${ET}`);

    const byAction = await get(oh, `?entityType=${ET}&action=SETTING_UPDATED`);
    expect(ids(byAction.body).sort()).toEqual([row.byZmHome, row.panIndia].sort());

    const byActor = await get(oh, `?entityType=${ET}&actorUserId=${zmUserId}`);
    expect(ids(byActor.body)).toEqual([row.byZmHome]);

    const byActedAs = await get(oh, `?entityType=${ET}&actedAsRole=ZONAL_MANAGER`);
    expect(ids(byActedAs.body).sort()).toEqual([row.actingHere, row.actingThere].sort());

    const byEntity = await get(oh, `?entityType=${ET}&entityId=pan-india-${NS}`);
    expect(ids(byEntity.body)).toEqual([row.panIndia]);

    const byZone = await get(oh, `?entityType=${ET}&zoneId=${otherZone}`);
    expect(ids(byZone.body)).toEqual([row.actingThere]);

    // Different filters must not return byte-identical bodies.
    expect(JSON.stringify(byAction.body)).not.toEqual(JSON.stringify(all.body));
    expect(JSON.stringify(byActor.body)).not.toEqual(JSON.stringify(byActedAs.body));
  });

  it('AC1 — from/to bound the window on created_at', async () => {
    const oh = await login('ops.head@fsm.test');
    const from = new Date(BASE.getTime() + 1 * 60_000).toISOString();
    const to = new Date(BASE.getTime() + 4 * 60_000).toISOString();
    const res = await get(oh, `?entityType=${ET}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    expect(ids(res.body).sort()).toEqual([row.actingThere, row.byZmHome].sort());
  });

  it('AC3 — metadata is returned verbatim so the viewer can render from/to', async () => {
    const oh = await login('ops.head@fsm.test');
    const res = await get(oh, `?entityType=${ET}&entityId=acting-here-${NS}`);
    expect(res.body.rows[0].metadata).toEqual({ previous: 'HOLD', next: 'APPROVED', reason: 'covering north' });
    expect(res.body.rows[0].actedAsRole).toBe('ZONAL_MANAGER');
    expect(res.body.rows[0].actorName).toEqual(expect.any(String));
  });

  it('AC5 — keyset pagination walks the ledger without repeating or skipping a row', async () => {
    const oh = await login('ops.head@fsm.test');
    const first = await get(oh, `?entityType=${ET}&limit=2`);
    expect(ids(first.body)).toEqual([row.actingHere, row.actingThere]);
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const second = await get(oh, `?entityType=${ET}&limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(ids(second.body)).toEqual([row.byZmHome, row.panIndia]);
    expect(second.body.nextCursor).toBeNull();
  });

  it('AC5 — limit above 200 is rejected, and a malformed cursor is a 400', async () => {
    const oh = await login('ops.head@fsm.test');
    await get(oh, '?limit=201', 400);
    await get(oh, '?limit=0', 400);
    await get(oh, '?cursor=not-a-cursor', 400);
    await get(oh, '?from=not-a-date', 400);
  });

  it('forbids a Service Engineer (403)', async () => {
    const se = await login('se.north@fsm.test');
    await get(se, `?entityType=${ET}`, 403);
  });
});
