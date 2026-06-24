import { PrismaService } from '../src/prisma/prisma.service';
import { TicketCreationService } from '../src/ticketing/ticket-creation.service';

/**
 * Issue 08, slice 4 — repeat-failure detection (AC#4/#6, ADR-0021). When TicketCreation opens a new
 * cycle for a device that has a prior VERIFIED cycle within 24h, the new cycle opens as REPEAT with
 * `repeat_failure = true` and a `previous_failure_cycle_id` link; the prior VERIFIED cycle is never
 * mutated. A first-time device opens a plain OPEN cycle.
 */
const DEV_REPEAT = 9_084_001n;
const DEV_FIRST = 9_084_002n;
const ALL = [DEV_REPEAT, DEV_FIRST];

describe('Issue 08 slice 4 — repeat-failure detection', () => {
  let prisma: PrismaService;
  let service: TicketCreationService;
  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let priorCycleId: string;

  const NOW = new Date(Date.UTC(2026, 5, 20, 12, 0, 0));

  const seedState = (deviceId: bigint) =>
    prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        inactivityHours: 30,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        hasOpenFailureCycle: false,
        plantId,
        companyId,
        computedAt: NOW,
      },
    });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new TicketCreationService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-rf-' + Date.now() } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-rf', companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-rf', zoneId } })).plantId;

    for (const deviceId of ALL) await prisma.device.create({ data: { deviceId } });
    // DEV_REPEAT has a prior VERIFIED cycle closed 1h ago (inside the 24h repeat window).
    priorCycleId = (
      await prisma.failureCycle.create({
        data: {
          deviceId: DEV_REPEAT,
          state: 'VERIFIED',
          openedAt: new Date(NOW.getTime() - 5 * 3_600_000),
          closedAt: new Date(NOW.getTime() - 1 * 3_600_000),
        },
      })
    ).cycleId;
    await seedState(DEV_REPEAT);
    await seedState(DEV_FIRST);
  });

  afterAll(async () => {
    await prisma.ticketEvent.deleteMany({ where: { ticket: { deviceId: { in: ALL } } } });
    await prisma.ticket.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('opens a REPEAT cycle linked to the prior, and leaves the prior VERIFIED cycle immutable', async () => {
    await service.createForInactiveEligible(NOW);

    const newCycle = await prisma.failureCycle.findFirstOrThrow({
      where: { deviceId: DEV_REPEAT, state: 'REPEAT' },
    });
    expect(newCycle.repeatFailure).toBe(true);
    expect(newCycle.previousFailureCycleId).toBe(priorCycleId);

    const ticket = await prisma.ticket.findFirstOrThrow({ where: { deviceId: DEV_REPEAT } });
    expect(ticket.repeatFailure).toBe(true);

    // Prior cycle untouched (AC#6 immutability).
    const prior = await prisma.failureCycle.findUniqueOrThrow({ where: { cycleId: priorCycleId } });
    expect(prior.state).toBe('VERIFIED');
  });

  it('opens a plain OPEN cycle for a first-time failure', async () => {
    await service.createForInactiveEligible(NOW);

    const cycles = await prisma.failureCycle.findMany({ where: { deviceId: DEV_FIRST } });
    expect(cycles).toHaveLength(1);
    expect(cycles[0].state).toBe('OPEN');
    expect(cycles[0].repeatFailure).toBe(false);
    expect(cycles[0].previousFailureCycleId).toBeNull();
  });
});
