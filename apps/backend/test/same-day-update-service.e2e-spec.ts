import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { SameDayUpdateService } from '../src/scheduling/same-day-update.service';

/**
 * Issue 31 slice 1, re-scoped by **#356**. `SameDayUpdateService` is now a **read**: #313 made
 * `POST /batches/:id/override` the single same-day write surface, and `addTicket` / `removeTicket` /
 * `reorder` (with the three `/intraday-updates/*` routes that called them) are deleted rather than
 * left standing as doors nothing opens. What remains is `listIntradayUpdates` — the Intra-day Queue's
 * `MANUAL_ZM_UPDATE` stream.
 *
 * So this spec seeds the audit rows directly instead of writing them through a producer. That is the
 * honest shape now: the read's contract is "what is in `audit_logs`", and coupling its spec to one
 * particular writer was what made the read untestable at scale in the first place — you cannot ask a
 * bounded read about its 60th row if the only way to make 60 rows is 60 formal assignments.
 *
 * What is under test is #356's AC1 half for this stream: the read is **bounded** (a default window,
 * a caller-set `take`, a hard ceiling), **newest-first**, **cursor-paged**, `since`-filterable, and
 * still zone-scoped for a ZM — the scoping being the reason the bound cannot be a naive `take` on the
 * SQL query, since a ZM's rows are only known after each row's zone is resolved.
 */
const NS = Date.now();

describe('#356 — the Intra-day Queue MANUAL_ZM_UPDATE read is bounded', () => {
  let prisma: PrismaService;
  let sameDay: SameDayUpdateService;

  let zoneId: bigint;
  let otherZoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let otherPlantId: bigint;
  let se: string;
  /** 60 tickets in the ZM's zone, each with one MANUAL_ZM_UPDATE row — more than one default page. */
  const inZoneTickets: string[] = [];
  let outOfZoneTicket: string;
  const auditIds: bigint[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  const userIds: string[] = [];
  const ZM_ID = randomUUID();
  const NOW = new Date('2026-06-25T06:00:00Z');
  let scope: { role: string; zoneId: number };

  const makeTicket = async (plant: bigint): Promise<string> => {
    const deviceId = String(10_950_000_000 + ((NS + deviceIds.length) % 1_000_000) + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
    const t = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        failureCycleId: cycle.cycleId,
        deviceId,
        plantId: plant,
        companyId,
        companyTier: 'GOLD',
        lastStateChangedAt: NOW,
      },
    });
    ticketIds.push(t.ticketId);
    return t.ticketId;
  };

  const logUpdate = async (ticketId: string, at: Date): Promise<bigint> => {
    const row = await prisma.auditLog.create({
      data: {
        actorId: ZM_ID,
        actorRole: 'ZONAL_MANAGER',
        action: 'MANUAL_ZM_UPDATE',
        entityType: 'ticket',
        entityId: ticketId,
        metadata: { updateType: 'ADD', seId: se },
        createdAt: at,
      },
    });
    auditIds.push(row.id);
    return row.id;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    sameDay = new SameDayUpdateService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-sdu-' + NS } })).zoneId;
    otherZoneId = (await prisma.zone.create({ data: { name: 'Z-sdu-other-' + NS } })).zoneId;
    scope = { role: 'ZONAL_MANAGER', zoneId: Number(zoneId) };
    companyId = (
      await prisma.company.create({ data: { name: 'Co-sdu-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-sdu-' + NS, zoneId } })).plantId;
    otherPlantId = (await prisma.plant.create({ data: { name: 'P-sdu-other-' + NS, zoneId: otherZoneId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'sdu-' + tag, email: `${tag}-${NS}@sdu.test`, zoneId },
    });
    userIds.push(u.userId);
    se = u.userId;

    // The out-of-zone row is written FIRST (oldest), so it can never be the reason a ZM's page is
    // short — it sits below every in-zone row a default page could reach.
    outOfZoneTicket = await makeTicket(otherPlantId);
    await logUpdate(outOfZoneTicket, new Date(NOW.getTime() - 60 * 60_000));

    for (let i = 0; i < 60; i++) {
      const t = await makeTicket(plantId);
      inZoneTickets.push(t);
      await logUpdate(t, new Date(NOW.getTime() + i * 60_000));
    }
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { id: { in: auditIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [plantId, otherPlantId] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: [zoneId, otherZoneId] } } });
    await prisma.onModuleDestroy();
  });

  it('AC1 — a default read is capped at 50 rows, newest first, and says there is more', async () => {
    const page = await sameDay.listIntradayUpdates(scope);
    expect(page.limit).toBe(50);
    expect(page.rows).toHaveLength(50);
    // Newest first: the last row seeded (i = 59) leads.
    expect(page.rows[0].ticketId).toBe(inZoneTickets[59]);
    expect(page.rows[49].ticketId).toBe(inZoneTickets[10]);
    expect(page.nextCursor).not.toBeNull();
  });

  it('AC1 — the cursor pages through the rest without repeating or skipping a row', async () => {
    const first = await sameDay.listIntradayUpdates(scope, { take: 25 });
    expect(first.rows).toHaveLength(25);
    const second = await sameDay.listIntradayUpdates(scope, { take: 25, cursor: BigInt(first.nextCursor!) });
    expect(second.rows).toHaveLength(25);

    const ids = [...first.rows, ...second.rows].map((r) => r.auditId);
    expect(new Set(ids).size).toBe(50);
    // The two pages, laid end to end, are exactly the newest 50 in-zone rows in order.
    const seen = [...first.rows, ...second.rows].map((r) => r.ticketId);
    expect(seen).toEqual([...inZoneTickets].reverse().slice(0, 50));
  });

  it('AC1 — `take` is honoured and clamped to a ceiling no caller can raise', async () => {
    expect((await sameDay.listIntradayUpdates(scope, { take: 3 })).rows).toHaveLength(3);
    const huge = await sameDay.listIntradayUpdates(scope, { take: 10_000 });
    expect(huge.limit).toBe(200);
    // 60 in-zone rows exist, so the ceiling is not what bounds this page — exhaustion is.
    expect(huge.rows).toHaveLength(60);
    expect(huge.nextCursor).toBeNull();
  });

  it('AC1 — `since` filters by date', async () => {
    const since = new Date(NOW.getTime() + 50 * 60_000);
    const page = await sameDay.listIntradayUpdates(scope, { since });
    expect(page.rows).toHaveLength(10);
    expect(page.rows.every((r) => new Date(r.createdAt) >= since)).toBe(true);
  });

  it('stays zone-scoped for a ZM — the bound is applied to their rows, not to the raw scan', async () => {
    const page = await sameDay.listIntradayUpdates(scope, { take: 200 });
    expect(page.rows.some((r) => r.ticketId === outOfZoneTicket)).toBe(false);
    // A cross-zone role sees both zones' rows.
    const csm = await sameDay.listIntradayUpdates({ role: 'CENTRAL_SERVICE_MANAGER', zoneId: null }, { take: 200 });
    expect(csm.rows.some((r) => r.ticketId === outOfZoneTicket)).toBe(true);
  });

  it('hides the updates from a different zone (ZM zone-scoping)', async () => {
    const otherZone = await sameDay.listIntradayUpdates({ role: 'ZONAL_MANAGER', zoneId: Number(otherZoneId) });
    expect(otherZone.rows.some((u) => inZoneTickets.includes(u.ticketId ?? ''))).toBe(false);
    expect(otherZone.rows.some((u) => u.ticketId === outOfZoneTicket)).toBe(true);
  });

  it('carries the row shape the queue renders', async () => {
    const page = await sameDay.listIntradayUpdates(scope, { take: 1 });
    const row = page.rows[0];
    expect(row.updateType).toBe('ADD');
    expect(row.seId).toBe(se);
    expect(row.actorId).toBe(ZM_ID);
    expect(row.ticketId).toBe(inZoneTickets[59]);
  });
});
