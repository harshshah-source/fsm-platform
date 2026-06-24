import { PrismaService } from '../src/prisma/prisma.service';
import { AutoRecoveryService } from '../src/ticketing/auto-recovery.service';

/**
 * Issue 08, slice 2 — auto-recovery (AC#1/#2). A device that resumes pinging (≥3 pings ≥15 min)
 * while its Troubleshoot Ticket is OPEN auto-closes as CLOSED_AUTO_RECOVERY — no form — the cycle
 * goes VERIFIED, the open-cycle flag clears, and a lifecycle event is recorded. A device that has
 * not recovered stays OPEN.
 */
const DEV_RECOVERED = 9_081_001n;
const DEV_STILL_DOWN = 9_081_002n;
const ALL = [DEV_RECOVERED, DEV_STILL_DOWN];

describe('Issue 08 slice 2 — AutoRecoveryService', () => {
  let prisma: PrismaService;
  let service: AutoRecoveryService;
  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let runId: bigint;

  const NOW = new Date(Date.UTC(2026, 5, 20, 12, 0, 0));
  const opened = new Date(NOW.getTime() - 120 * 60_000);
  const minsAfterOpen = (m: number) => new Date(opened.getTime() + m * 60_000);

  const seed = async (deviceId: bigint, pingOffsets: number[]) => {
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        inactivityHours: 2,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        hasOpenFailureCycle: true,
        plantId,
        companyId,
        computedAt: NOW,
      },
    });
    const cycle = await prisma.failureCycle.create({
      data: { deviceId, state: 'OPEN', openedAt: opened },
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
        lastStateChangedAt: opened,
      },
    });
    await prisma.ticketEvent.create({
      data: { ticketId: ticket.ticketId, fromState: null, toState: 'OPEN', at: opened },
    });
    for (const off of pingOffsets) {
      await prisma.rawDeviceSnapshot.create({
        data: { runId, deviceId, gpsDatetime: minsAfterOpen(off) },
      });
    }
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new AutoRecoveryService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-ar-' + Date.now() } })).zoneId;
    companyId = (
      await prisma.company.create({
        data: { name: 'Co-ar', companyTier: 'GOLD', companyPriorityRank: 'B' },
      })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-ar', zoneId } })).plantId;
    runId = (await prisma.snapshotRun.create({ data: { status: 'SUCCESS' } })).runId;

    await seed(DEV_RECOVERED, [90, 100, 110]); // 3 pings, 20-min span → recovered
    await seed(DEV_STILL_DOWN, [90]); // 1 ping → not recovered
  });

  afterAll(async () => {
    await prisma.ticketEvent.deleteMany({ where: { ticket: { deviceId: { in: ALL } } } });
    await prisma.ticket.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.rawDeviceSnapshot.deleteMany({ where: { runId } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.snapshotRun.deleteMany({ where: { runId } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('auto-closes a recovered device as CLOSED_AUTO_RECOVERY and verifies its cycle', async () => {
    await service.runAutoRecovery(NOW);

    const ticket = await prisma.ticket.findFirstOrThrow({ where: { deviceId: DEV_RECOVERED } });
    expect(ticket.status).toBe('CLOSED_AUTO_RECOVERY');

    const cycle = await prisma.failureCycle.findFirstOrThrow({ where: { deviceId: DEV_RECOVERED } });
    expect(cycle.state).toBe('VERIFIED');
    expect(cycle.closedAt).not.toBeNull();

    const state = await prisma.deviceState.findUniqueOrThrow({ where: { deviceId: DEV_RECOVERED } });
    expect(state.hasOpenFailureCycle).toBe(false);

    const events = await prisma.ticketEvent.findMany({
      where: { ticket: { deviceId: DEV_RECOVERED } },
      orderBy: { at: 'asc' },
    });
    expect(events.at(-1)!.toState).toBe('CLOSED_AUTO_RECOVERY');
  });

  it('leaves a still-inactive device OPEN', async () => {
    await service.runAutoRecovery(NOW);
    const ticket = await prisma.ticket.findFirstOrThrow({ where: { deviceId: DEV_STILL_DOWN } });
    expect(ticket.status).toBe('OPEN');
  });
});
