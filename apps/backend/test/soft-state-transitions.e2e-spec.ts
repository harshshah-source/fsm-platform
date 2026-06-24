import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { SoftStateService } from '../src/soft-state/soft-state.service';

/**
 * Issue 15, slice 2 — soft-state transition enforcement (AC#1). The SE field-progress chain is
 * VIEWED → ON_SITE → TROUBLESHOOT_STARTED; advancing one step resolves the prior state (single active
 * progression per SE per ticket). Skipping a step, going backwards, or starting above VIEWED is
 * rejected as INVALID_TRANSITION; re-advancing to the current state is idempotent.
 */
const NS = Date.now();
const NOW = new Date('2026-06-23T06:00:00Z');

describe('Issue 15 slice 2 — soft-state transitions', () => {
  let prisma: PrismaService;
  let svc: SoftStateService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let se: string;
  const deviceIds: bigint[] = [];
  const ticketIds: string[] = [];

  const makeTicket = async (): Promise<string> => {
    const deviceId = BigInt(10_600_000_000 + (NS % 100_000) * 10 + deviceIds.length);
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

    zoneId = (await prisma.zone.create({ data: { name: 'Z-ss-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-ss-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-ss-' + NS, zoneId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@ss.test`, zoneId },
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

  it('walks VIEWED → ON_SITE → TROUBLESHOOT_STARTED, resolving each prior state on advance', async () => {
    const ticketId = await makeTicket();

    const viewed = await svc.advance({ ticketId, seId: se, target: 'VIEWED', now: NOW });
    expect(viewed.result).toBe('OK');
    expect(viewed.result === 'OK' && viewed.softState.type).toBe('VIEWED');
    expect(viewed.result === 'OK' && viewed.softState.timeoutAt).not.toBeNull(); // VIEWED carries a timeout

    const onSite = await svc.advance({ ticketId, seId: se, target: 'ON_SITE', now: NOW });
    expect(onSite.result).toBe('OK');

    // The VIEWED state is resolved (advanced); exactly one active state remains, ON_SITE.
    const active = await prisma.softState.findMany({ where: { ticketId, seId: se, resolvedAt: null } });
    expect(active.length).toBe(1);
    expect(active[0].type).toBe('ON_SITE');

    const started = await svc.advance({ ticketId, seId: se, target: 'TROUBLESHOOT_STARTED', now: NOW });
    expect(started.result).toBe('OK');
    const activeAfter = await prisma.softState.findMany({ where: { ticketId, seId: se, resolvedAt: null } });
    expect(activeAfter.map((s) => s.type)).toEqual(['TROUBLESHOOT_STARTED']);
  });

  it('rejects starting above VIEWED on a fresh ticket', async () => {
    const ticketId = await makeTicket();
    const outcome = await svc.advance({ ticketId, seId: se, target: 'TROUBLESHOOT_STARTED', now: NOW });
    expect(outcome.result).toBe('INVALID_TRANSITION');
    expect(outcome.result === 'INVALID_TRANSITION' && outcome.from).toBeNull();
  });

  it('rejects a backward transition (ON_SITE → VIEWED)', async () => {
    const ticketId = await makeTicket();
    await svc.advance({ ticketId, seId: se, target: 'VIEWED', now: NOW });
    await svc.advance({ ticketId, seId: se, target: 'ON_SITE', now: NOW });
    const outcome = await svc.advance({ ticketId, seId: se, target: 'VIEWED', now: NOW });
    expect(outcome.result).toBe('INVALID_TRANSITION');
    expect(outcome.result === 'INVALID_TRANSITION' && outcome.from).toBe('ON_SITE');
  });

  it('rejects skipping a step (VIEWED → TROUBLESHOOT_STARTED)', async () => {
    const ticketId = await makeTicket();
    await svc.advance({ ticketId, seId: se, target: 'VIEWED', now: NOW });
    const outcome = await svc.advance({ ticketId, seId: se, target: 'TROUBLESHOOT_STARTED', now: NOW });
    expect(outcome.result).toBe('INVALID_TRANSITION');
  });

  it('is idempotent when re-advancing to the already-active state', async () => {
    const ticketId = await makeTicket();
    const first = await svc.advance({ ticketId, seId: se, target: 'VIEWED', now: NOW });
    const again = await svc.advance({ ticketId, seId: se, target: 'VIEWED', now: NOW });
    expect(again.result).toBe('IDEMPOTENT');
    // No duplicate active row (the ux_ss_active partial unique also guards this).
    const active = await prisma.softState.findMany({ where: { ticketId, seId: se, type: 'VIEWED', resolvedAt: null } });
    expect(active.length).toBe(1);
    expect(first.result === 'OK' && again.result === 'IDEMPOTENT' && first.softState.softStateId).toBe(
      again.result === 'IDEMPOTENT' ? again.softState.softStateId : -1n,
    );
  });
});
