import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { SoftStateService } from '../src/soft-state/soft-state.service';

/**
 * Issue 15, slice 7 — SE Activity Status, DB-backed (AC#6, ADR-0023). `activityStatusFor` derives the
 * label from the SE's active soft states + `last_activity_at` + shift end at query time — nothing is
 * stored. (SE_AVAILABILITY sourcing lands with Issue 25; until then availability is treated AVAILABLE.)
 */
const NS = Date.now();
const NOW = new Date('2026-06-23T10:00:00Z');

describe('Issue 15 slice 7 — activityStatusFor', () => {
  let prisma: PrismaService;
  let svc: SoftStateService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let se: string;
  const deviceIds: bigint[] = [];
  const ticketIds: string[] = [];

  const makeTicket = async (): Promise<string> => {
    const deviceId = BigInt(11_100_000_000 + (NS % 100_000) * 10 + deviceIds.length);
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

  /** Reset the SE to a clean slate: no active soft states, given heartbeat + shift end. */
  const reset = async (opts: { lastActivityAt: Date | null; shiftEnd?: Date | null }) => {
    await prisma.softState.updateMany({ where: { seId: se, resolvedAt: null }, data: { resolvedAt: NOW, resolvedBy: 'SYSTEM' } });
    await prisma.engineerMaster.update({
      where: { engineerId: se },
      data: { lastActivityAt: opts.lastActivityAt, shiftEnd: opts.shiftEnd ?? null },
    });
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new SoftStateService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-as-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-as-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-as-' + NS, zoneId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@as.test`, zoneId },
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

  it('derives ON_SITE from an active ON_SITE soft state', async () => {
    await reset({ lastActivityAt: NOW });
    const ticketId = await makeTicket();
    await svc.advance({ ticketId, seId: se, target: 'VIEWED', now: NOW });
    await svc.advance({ ticketId, seId: se, target: 'ON_SITE', now: NOW });
    expect(await svc.activityStatusFor(se, NOW)).toBe('ON_SITE');
  });

  it('derives BUSY from an active TROUBLESHOOT_STARTED soft state', async () => {
    await reset({ lastActivityAt: NOW });
    const ticketId = await makeTicket();
    await svc.advance({ ticketId, seId: se, target: 'VIEWED', now: NOW });
    await svc.advance({ ticketId, seId: se, target: 'ON_SITE', now: NOW });
    await svc.advance({ ticketId, seId: se, target: 'TROUBLESHOOT_STARTED', now: NOW });
    expect(await svc.activityStatusFor(se, NOW)).toBe('BUSY');
  });

  it('derives OFFLINE when the app has not pinged in over an hour and no soft state is held', async () => {
    await reset({ lastActivityAt: new Date(NOW.getTime() - 2 * 3_600_000) });
    expect(await svc.activityStatusFor(se, NOW)).toBe('OFFLINE');
  });

  it('derives AVAILABLE when recently active with no soft state', async () => {
    await reset({ lastActivityAt: new Date(NOW.getTime() - 5 * 60_000) });
    expect(await svc.activityStatusFor(se, NOW)).toBe('AVAILABLE');
  });

  it('derives SHIFT_ENDING within an hour of shift end (no soft state)', async () => {
    await reset({ lastActivityAt: NOW, shiftEnd: new Date('1970-01-01T10:30:00Z') }); // 30 min after NOW's time
    expect(await svc.activityStatusFor(se, NOW)).toBe('SHIFT_ENDING');
  });
});
