import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { SoftStateService } from '../src/soft-state/soft-state.service';
import { PrismaSoftStateConflictPort } from '../src/soft-state/soft-state-conflict.adapter';

/**
 * Issue 15, slice 8 — the real SoftStateConflictPort adapter (AC#7). Replaces the 13a no-conflict seam:
 * reports which of the given tickets currently carry an active ON_SITE / TROUBLESHOOT_STARTED soft
 * state, so a ZM override that touches one surfaces a conflict warning. VIEWED and resolved states do
 * not count as a conflict.
 */
const NS = Date.now();
const NOW = new Date('2026-06-23T11:00:00Z');

describe('Issue 15 slice 8 — PrismaSoftStateConflictPort', () => {
  let prisma: PrismaService;
  let svc: SoftStateService;
  let port: PrismaSoftStateConflictPort;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let se: string;
  const deviceIds: bigint[] = [];
  const ticketIds: string[] = [];

  const makeTicket = async (): Promise<string> => {
    const deviceId = BigInt(11_200_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        failureCycleId: cycle.cycleId,
        deviceId,
        plantId,
        companyId,
        companyTier: 'GOLD',
        lastStateChangedAt: NOW,
      },
    });
    ticketIds.push(ticket.ticketId);
    return ticket.ticketId;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new SoftStateService(prisma);
    port = new PrismaSoftStateConflictPort(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-cp-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-cp-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-cp-' + NS, zoneId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@cp.test`, zoneId },
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

  it('reports only tickets with an active ON_SITE or TROUBLESHOOT_STARTED soft state', async () => {
    const onSite = await makeTicket();
    await svc.advance({ ticketId: onSite, seId: se, target: 'VIEWED', now: NOW });
    await svc.advance({ ticketId: onSite, seId: se, target: 'ON_SITE', now: NOW });

    const busy = await makeTicket();
    await svc.advance({ ticketId: busy, seId: se, target: 'VIEWED', now: NOW });
    await svc.advance({ ticketId: busy, seId: se, target: 'ON_SITE', now: NOW });
    await svc.advance({ ticketId: busy, seId: se, target: 'TROUBLESHOOT_STARTED', now: NOW });

    const viewedOnly = await makeTicket();
    await svc.advance({ ticketId: viewedOnly, seId: se, target: 'VIEWED', now: NOW });

    const resolved = await makeTicket();
    await svc.advance({ ticketId: resolved, seId: se, target: 'VIEWED', now: NOW });
    await svc.advance({ ticketId: resolved, seId: se, target: 'ON_SITE', now: NOW });
    await prisma.softState.updateMany({
      where: { ticketId: resolved, resolvedAt: null },
      data: { resolvedAt: NOW, resolvedBy: 'ZM', resolutionReason: 'OVERRIDE' },
    });

    const result = await port.activeOnSiteTicketIds([onSite, busy, viewedOnly, resolved]);
    expect(result.has(onSite)).toBe(true);
    expect(result.has(busy)).toBe(true);
    expect(result.has(viewedOnly)).toBe(false);
    expect(result.has(resolved)).toBe(false);
    expect(result.size).toBe(2);
  });

  it('returns an empty set for an empty ticket list', async () => {
    expect((await port.activeOnSiteTicketIds([])).size).toBe(0);
  });
});
