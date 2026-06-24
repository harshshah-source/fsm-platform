import { PrismaService } from '../src/prisma/prisma.service';
import { RepeatEscalationService } from '../src/ticketing/repeat-escalation.service';

/**
 * Issue 08, slice 5 — repeat-failure escalation scan (AC#5, ADR-0021). A daily batch counts a
 * device's repeat episodes (`failure_cycle.repeat_failure = true`) opened in the last 7 days; at
 * 3+ it escalates the device's active cycle + ticket to ESCALATED and records a lifecycle event.
 * Below the threshold nothing changes. The device still down — the episode is not closed.
 */
const DEV_ESC = 9_088_001n; // 3 repeat cycles in 7d → escalates
const DEV_TWO = 9_088_002n; // 2 repeat cycles in 7d → stays put
const ALL = [DEV_ESC, DEV_TWO];

describe('Issue 08 slice 5 — RepeatEscalationService.runEscalationScan', () => {
  let prisma: PrismaService;
  let service: RepeatEscalationService;
  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;

  const NOW = new Date(Date.UTC(2026, 5, 21, 12, 0, 0));
  const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

  /** A closed (VERIFIED) repeat episode that still counts via its immutable repeat_failure flag. */
  const seedClosedRepeat = (deviceId: bigint, openedDaysAgo: number) =>
    prisma.failureCycle.create({
      data: {
        deviceId,
        state: 'VERIFIED',
        openedAt: daysAgo(openedDaysAgo),
        closedAt: daysAgo(openedDaysAgo),
        repeatFailure: true,
      },
    });

  /** The device's current active REPEAT cycle + its open ticket. */
  const seedActiveRepeat = async (deviceId: bigint) => {
    const cycle = await prisma.failureCycle.create({
      data: { deviceId, state: 'REPEAT', openedAt: daysAgo(1), repeatFailure: true },
    });
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        failureCycleId: cycle.cycleId,
        deviceId,
        plantId,
        companyId,
        companyTier: 'GOLD',
        repeatFailure: true,
        lastStateChangedAt: daysAgo(1),
      },
    });
    await prisma.ticketEvent.create({
      data: { ticketId: ticket.ticketId, fromState: null, toState: 'OPEN', at: daysAgo(1) },
    });
    return { cycleId: cycle.cycleId, ticketId: ticket.ticketId };
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new RepeatEscalationService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-esc-' + Date.now() } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-esc', companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-esc', zoneId } })).plantId;
    for (const deviceId of ALL) await prisma.device.create({ data: { deviceId } });

    // DEV_ESC: two earlier repeat episodes (recovered) + one active repeat = 3 repeats in 7d.
    await seedClosedRepeat(DEV_ESC, 5);
    await seedClosedRepeat(DEV_ESC, 3);
    await seedActiveRepeat(DEV_ESC);

    // DEV_TWO: one earlier repeat + one active repeat = 2 repeats in 7d (below threshold).
    await seedClosedRepeat(DEV_TWO, 4);
    await seedActiveRepeat(DEV_TWO);
  });

  afterAll(async () => {
    await prisma.ticketEvent.deleteMany({ where: { ticket: { deviceId: { in: ALL } } } });
    await prisma.ticket.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('escalates a device with 3+ repeat cycles in 7d (active cycle + ticket → ESCALATED + event)', async () => {
    const result = await service.runEscalationScan(NOW);
    expect(result.escalated).toBe(1);

    const cycle = await prisma.failureCycle.findFirstOrThrow({
      where: { deviceId: DEV_ESC, state: { in: ['REPEAT', 'ESCALATED'] } },
    });
    expect(cycle.state).toBe('ESCALATED');

    const ticket = await prisma.ticket.findFirstOrThrow({ where: { deviceId: DEV_ESC } });
    expect(ticket.status).toBe('ESCALATED');

    const events = await prisma.ticketEvent.findMany({
      where: { ticket: { deviceId: DEV_ESC } },
      orderBy: { at: 'asc' },
    });
    expect(events.at(-1)!.toState).toBe('ESCALATED');
  });

  it('does not escalate a device with only 2 repeat cycles in 7d', async () => {
    await service.runEscalationScan(NOW);

    const ticket = await prisma.ticket.findFirstOrThrow({ where: { deviceId: DEV_TWO } });
    expect(ticket.status).toBe('OPEN');
    const cycle = await prisma.failureCycle.findFirstOrThrow({
      where: { deviceId: DEV_TWO, state: { in: ['REPEAT', 'ESCALATED'] } },
    });
    expect(cycle.state).toBe('REPEAT');
  });
});
