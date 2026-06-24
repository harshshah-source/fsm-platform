import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { SoftStateService } from '../src/soft-state/soft-state.service';

/**
 * Issue 15, slice 6 — stale-work warning (AC#5). ON_SITE / TROUBLESHOOT_STARTED held longer than the
 * configured threshold (`onsite_stale_warning_hours` / `troubleshoot_started_stale_warning_hours`,
 * default 2 h) surface as a ZM stale-work warning. The warning is an attention signal only — it does
 * NOT clear the state (CONTEXT §Soft State: timer-based expiry would discard valid active field work).
 */
const NS = Date.now();

describe('Issue 15 slice 6 — stale-work warning', () => {
  let prisma: PrismaService;
  let svc: SoftStateService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let se: string;
  const deviceIds: bigint[] = [];
  const ticketIds: string[] = [];

  const makeTicket = async (at: Date): Promise<string> => {
    const deviceId = BigInt(11_000_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: at } });
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        failureCycleId: cycle.cycleId,
        deviceId,
        plantId,
        companyId,
        companyTier: 'GOLD',
        lastStateChangedAt: at,
      },
    });
    ticketIds.push(ticket.ticketId);
    return ticket.ticketId;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new SoftStateService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-sw-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-sw-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-sw-' + NS, zoneId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@sw.test`, zoneId },
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

  it('flags an ON_SITE held past the threshold without clearing it', async () => {
    const setAt = new Date('2026-06-23T03:00:00Z');
    const ticketId = await makeTicket(setAt);
    await svc.advance({ ticketId, seId: se, target: 'VIEWED', now: setAt });
    const on = await svc.advance({ ticketId, seId: se, target: 'ON_SITE', now: setAt });
    const id = on.result === 'OK' ? on.softState.softStateId : 0n;

    const now = new Date('2026-06-23T06:00:00Z'); // 3 h later, threshold is 2 h
    const warnings = await svc.staleWorkWarnings(now);
    expect(warnings.some((w) => w.softStateId === id && w.type === 'ON_SITE')).toBe(true);

    // The warning does not resolve the state — it is an attention signal only.
    const row = await prisma.softState.findUniqueOrThrow({ where: { softStateId: id } });
    expect(row.resolvedAt).toBeNull();
  });

  it('does not flag an ON_SITE still within the threshold', async () => {
    const setAt = new Date('2026-06-23T05:30:00Z');
    const ticketId = await makeTicket(setAt);
    await svc.advance({ ticketId, seId: se, target: 'VIEWED', now: setAt });
    const on = await svc.advance({ ticketId, seId: se, target: 'ON_SITE', now: setAt });
    const id = on.result === 'OK' ? on.softState.softStateId : 0n;

    const now = new Date('2026-06-23T06:00:00Z'); // only 30 min later
    const warnings = await svc.staleWorkWarnings(now);
    expect(warnings.some((w) => w.softStateId === id)).toBe(false);
  });

  it('flags a TROUBLESHOOT_STARTED held past the threshold', async () => {
    const setAt = new Date('2026-06-23T02:00:00Z');
    const ticketId = await makeTicket(setAt);
    await svc.advance({ ticketId, seId: se, target: 'VIEWED', now: setAt });
    await svc.advance({ ticketId, seId: se, target: 'ON_SITE', now: setAt });
    const ts = await svc.advance({ ticketId, seId: se, target: 'TROUBLESHOOT_STARTED', now: setAt });
    const id = ts.result === 'OK' ? ts.softState.softStateId : 0n;

    const now = new Date('2026-06-23T06:00:00Z'); // 4 h later
    const warnings = await svc.staleWorkWarnings(now);
    const warning = warnings.find((w) => w.softStateId === id);
    expect(warning?.type).toBe('TROUBLESHOOT_STARTED');
    expect(warning && warning.heldHours >= 2).toBe(true);
  });
});
