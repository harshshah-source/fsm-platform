import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { SoftStateService } from '../src/soft-state/soft-state.service';

/**
 * Issue 15, slice 4 — SE Activity Ping (AC#3, ADR-0024). Any SE-initiated app action stamps
 * `engineer_master.last_activity_at`; the ping is visibility/telemetry only — it never gates scoring
 * (memory: activity-ping-never-gates-scoring) and never auto-clears a soft state. Background processes
 * must not ping (enforced by only ever calling this on SE-action paths).
 */
const NS = Date.now();
const NOW = new Date('2026-06-23T08:00:00Z');

describe('Issue 15 slice 4 — SE activity ping', () => {
  let prisma: PrismaService;
  let svc: SoftStateService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let se: string;
  const deviceIds: bigint[] = [];
  const ticketIds: string[] = [];

  const makeTicket = async (): Promise<string> => {
    const deviceId = BigInt(10_800_000_000 + (NS % 100_000) * 10 + deviceIds.length);
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

  const lastActivity = async (): Promise<Date | null> =>
    (await prisma.engineerMaster.findUniqueOrThrow({ where: { engineerId: se } })).lastActivityAt;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new SoftStateService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-ap-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-ap-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-ap-' + NS, zoneId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@ap.test`, zoneId },
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

  it('stamps last_activity_at on an explicit SE activity ping', async () => {
    const t = new Date('2026-06-23T08:15:00Z');
    await svc.recordActivityPing(se, t);
    expect((await lastActivity())?.toISOString()).toBe(t.toISOString());
  });

  it('an SE-initiated soft-state action also stamps last_activity_at', async () => {
    const ticketId = await makeTicket();
    const t = new Date('2026-06-23T08:30:00Z');
    await svc.advance({ ticketId, seId: se, target: 'VIEWED', now: t });
    expect((await lastActivity())?.toISOString()).toBe(t.toISOString());
  });

  it('a ping never clears an active soft state', async () => {
    const ticketId = await makeTicket();
    await svc.advance({ ticketId, seId: se, target: 'VIEWED', now: NOW });
    await svc.advance({ ticketId, seId: se, target: 'ON_SITE', now: NOW });

    await svc.recordActivityPing(se, new Date('2026-06-23T09:00:00Z'));

    const active = await prisma.softState.findMany({ where: { ticketId, seId: se, resolvedAt: null } });
    expect(active.map((s) => s.type)).toEqual(['ON_SITE']); // unchanged — still active
  });
});
