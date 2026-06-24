import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { SoftStateService } from '../src/soft-state/soft-state.service';

/**
 * Issue 15, slice 5 — VIEWED timeout vs ON_SITE/TROUBLESHOOT_STARTED non-expiry (AC#4). VIEWED carries
 * a configurable `timeout_at` (Operations-Head setting `viewed_soft_state_timeout_minutes`) and the
 * sweep resolves it as SYSTEM/VIEWED_TIMEOUT (audit-retained, not deleted). ON_SITE/TROUBLESHOOT_STARTED
 * carry no timeout and are never time-expired — only explicit resolution events clear them.
 */
const NS = Date.now();
const VIEWED_KEY = 'viewed_soft_state_timeout_minutes';

describe('Issue 15 slice 5 — VIEWED timeout', () => {
  let prisma: PrismaService;
  let svc: SoftStateService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let se: string;
  const deviceIds: bigint[] = [];
  const ticketIds: string[] = [];
  const T0 = new Date('2026-06-23T06:00:00Z');

  const makeTicket = async (): Promise<string> => {
    const deviceId = BigInt(10_900_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: T0 } });
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        failureCycleId: cycle.cycleId,
        deviceId,
        plantId,
        companyId,
        companyTier: 'GOLD',
        lastStateChangedAt: T0,
      },
    });
    ticketIds.push(ticket.ticketId);
    return ticket.ticketId;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new SoftStateService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-vt-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-vt-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-vt-' + NS, zoneId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@vt.test`, zoneId },
    });
    se = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
  });

  afterAll(async () => {
    await prisma.softState.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: se } });
    await prisma.user.deleteMany({ where: { userId: se } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('honours the configurable VIEWED timeout from system_settings', async () => {
    await prisma.systemSetting.upsert({
      where: { key: VIEWED_KEY },
      create: { key: VIEWED_KEY, value: 30 },
      update: { value: 30 },
    });
    try {
      const ticketId = await makeTicket();
      const res = await svc.advance({ ticketId, seId: se, target: 'VIEWED', now: T0 });
      expect(res.result).toBe('OK');
      const expected = new Date(T0.getTime() + 30 * 60_000).toISOString();
      expect(res.result === 'OK' && res.softState.timeoutAt?.toISOString()).toBe(expected);
    } finally {
      await prisma.systemSetting.upsert({
        where: { key: VIEWED_KEY },
        create: { key: VIEWED_KEY, value: 90 },
        update: { value: 90 },
      });
    }
  });

  it('the sweep resolves an expired VIEWED as SYSTEM/VIEWED_TIMEOUT and retains the row', async () => {
    const ticketId = await makeTicket();
    const res = await svc.advance({ ticketId, seId: se, target: 'VIEWED', now: T0 }); // timeout_at = T0 + 90m
    const id = res.result === 'OK' ? res.softState.softStateId : 0n;

    const cleared = await svc.clearExpiredViewed(new Date(T0.getTime() + 2 * 60 * 60_000)); // T0 + 2h
    expect(cleared).toBeGreaterThanOrEqual(1);

    const row = await prisma.softState.findUniqueOrThrow({ where: { softStateId: id } });
    expect(row.resolvedAt).not.toBeNull(); // retained, just resolved
    expect(row.resolvedBy).toBe('SYSTEM');
    expect(row.resolutionReason).toBe('VIEWED_TIMEOUT');
  });

  it('the sweep leaves a not-yet-expired VIEWED active', async () => {
    const ticketId = await makeTicket();
    const res = await svc.advance({ ticketId, seId: se, target: 'VIEWED', now: T0 });
    const id = res.result === 'OK' ? res.softState.softStateId : 0n;

    await svc.clearExpiredViewed(new Date(T0.getTime() + 10 * 60_000)); // T0 + 10m, before the 90m timeout
    const row = await prisma.softState.findUniqueOrThrow({ where: { softStateId: id } });
    expect(row.resolvedAt).toBeNull(); // still active
  });

  it('the sweep never time-expires ON_SITE or TROUBLESHOOT_STARTED', async () => {
    const ticketId = await makeTicket();
    await svc.advance({ ticketId, seId: se, target: 'VIEWED', now: T0 });
    await svc.advance({ ticketId, seId: se, target: 'ON_SITE', now: T0 });

    await svc.clearExpiredViewed(new Date(T0.getTime() + 100 * 60 * 60_000)); // T0 + 100h, way past anything
    const active = await prisma.softState.findMany({ where: { ticketId, seId: se, resolvedAt: null } });
    expect(active.map((s) => s.type)).toEqual(['ON_SITE']); // ON_SITE untouched
  });
});
