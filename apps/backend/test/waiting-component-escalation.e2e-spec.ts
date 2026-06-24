import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { DashboardService } from '../src/dashboard/dashboard.service';

/**
 * Issue 23, slice 2 — the 7-day WAITING_COMPONENT escalation surfaces in the ZM Action Required panel
 * (CONTEXT §8 / §Waiting Component: a WAITING_COMPONENT cycle exceeding 7 days auto-escalates to the
 * Zonal Manager). The `waiting_component_overdue` Action Required card flips to available with a real,
 * zone-scoped count; cycles paused for less than 7 days do not count.
 */
const NS = Date.now();
const NOW = new Date('2026-06-24T09:00:00Z');
const EIGHT_DAYS_AGO = new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000);
const TWO_DAYS_AGO = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000);

describe('Issue 23 slice 2 — WAITING_COMPONENT > 7 days in Action Required', () => {
  let prisma: PrismaService;
  let svc: DashboardService;

  const zones: Record<'A' | 'B', bigint> = { A: 0n, B: 0n };
  let companyId: bigint;
  const plantByZone: Record<'A' | 'B', bigint> = { A: 0n, B: 0n };
  const deviceIds: bigint[] = [];
  const ticketIds: string[] = [];

  const seedWaiting = async (zoneKey: 'A' | 'B', pausedAt: Date): Promise<void> => {
    const deviceId = BigInt(12_300_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({
      data: {
        deviceId, state: 'WAITING_COMPONENT', openedAt: pausedAt,
        slaPaused: true, slaPauseReason: 'WAITING_COMPONENT', slaPausedAt: pausedAt,
      },
    });
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: cycle.cycleId, deviceId,
        plantId: plantByZone[zoneKey], companyId, companyTier: 'GOLD', lastStateChangedAt: pausedAt,
      },
    });
    ticketIds.push(ticket.ticketId);
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new DashboardService(prisma);

    zones.A = (await prisma.zone.create({ data: { name: 'Z-escA-' + NS } })).zoneId;
    zones.B = (await prisma.zone.create({ data: { name: 'Z-escB-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-esc-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantByZone.A = (await prisma.plant.create({ data: { name: 'P-escA-' + NS, zoneId: zones.A } })).plantId;
    plantByZone.B = (await prisma.plant.create({ data: { name: 'P-escB-' + NS, zoneId: zones.B } })).plantId;

    await seedWaiting('A', EIGHT_DAYS_AGO); // overdue, zone A
    await seedWaiting('A', TWO_DAYS_AGO); // not overdue
    await seedWaiting('B', EIGHT_DAYS_AGO); // overdue, zone B
  });

  afterAll(async () => {
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [plantByZone.A, plantByZone.B] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: [zones.A, zones.B] } } });
    await prisma.onModuleDestroy();
  });

  const cardFor = async (scope: { role: string; zoneId: number | null }) => {
    const cards = await svc.actionRequired(scope, NOW);
    return cards.find((c) => c.key === 'waiting_component_overdue')!;
  };

  it('flips the card available with the zone-scoped overdue count for a ZM', async () => {
    const card = await cardFor({ role: 'ZONAL_MANAGER', zoneId: Number(zones.A) });
    expect(card.available).toBe(true);
    expect(card.count).toBe(1); // only the 8-day cycle in zone A; the 2-day one does not count
  });

  it('counts all zones for Operations Head', async () => {
    const card = await cardFor({ role: 'OPERATIONS_HEAD', zoneId: null });
    expect(card.available).toBe(true);
    expect(card.count).toBe(2); // both overdue cycles (zone A + zone B)
  });

  it('keeps the card empty for an unrelated zone', async () => {
    const otherZone = (await prisma.zone.create({ data: { name: 'Z-escC-' + NS } })).zoneId;
    const card = await cardFor({ role: 'ZONAL_MANAGER', zoneId: Number(otherZone) });
    expect(card.count).toBe(0);
    await prisma.zone.deleteMany({ where: { zoneId: otherZone } });
  });
});
