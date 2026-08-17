import { PrismaService } from '../src/prisma/prisma.service';
import {
  DEFAULT_SE_ASSIGNMENT_THRESHOLD_HOURS,
  SE_ASSIGNMENT_THRESHOLD_KEY,
} from '../src/settings/assignment-threshold';
import { AutoRecoveryService } from '../src/ticketing/auto-recovery.service';
import { TicketCreationService } from '../src/ticketing/ticket-creation.service';

/**
 * #238, engine half — the SE-assignment threshold decides when device silence becomes fieldwork.
 *
 * Ticket creation and auto-recovery are **exact complements**: creation takes silence at or past the
 * threshold, recovery takes silence below it, and the two must partition the fleet so no device can be
 * touched by both on one telemetry pass. That invariant was previously carried by `is_inactive` on
 * both sides. #238 moved creation onto a configurable threshold, and the failure this file exists to
 * prevent is moving only one of them: with the threshold at 12 h a device silent 18 h would be
 * ticketed by creation and — on the same pass — handed to auto-recovery, because 18 h is not yet
 * `is_inactive` at the canonical 24 h. The ticket would open and close on every tick forever, each
 * closure filed as a self-healing device. It corrupts the productivity and component reports quietly
 * and indefinitely; nothing errors.
 *
 * Hours are seeded on `device_states` directly rather than driven through a recompute: the subject
 * here is the *predicate*, and deriving the input from the clock would make the test's own arithmetic
 * the thing most likely to break it.
 */
const DEV_18H = String(9_238_001n); // silent 18 h — between a 12 h and a 24 h threshold
const DEV_30H = String(9_238_002n); // silent 30 h — past 24 h, short of 48 h
const DEV_60H = String(9_238_003n); // silent 60 h — past every threshold under test
const ALL = [DEV_18H, DEV_30H, DEV_60H];

const HOURS: Record<string, number> = { [DEV_18H]: 18, [DEV_30H]: 30, [DEV_60H]: 60 };

describe('#238 engine — the assignment threshold gates ticket creation, and auto-recovery complements it', () => {
  let prisma: PrismaService;
  let creation: TicketCreationService;
  let recovery: AutoRecoveryService;
  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;

  const NOW = new Date(Date.UTC(2026, 7, 13, 12, 0, 0));

  const setThreshold = (hours: number) =>
    prisma.systemSetting.upsert({
      where: { key: SE_ASSIGNMENT_THRESHOLD_KEY },
      create: { key: SE_ASSIGNMENT_THRESHOLD_KEY, value: hours },
      update: { value: hours },
    });

  /** Reset every fixture device to "silent, eligible, no open episode" before each case. */
  const resetDevices = async () => {
    await prisma.ticketEvent.deleteMany({ where: { ticket: { deviceId: { in: ALL } } } });
    await prisma.ticket.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: ALL } } });
    for (const deviceId of ALL) {
      await prisma.deviceState.update({
        where: { deviceId },
        data: {
          inactivityHours: HOURS[deviceId],
          // `is_inactive` keeps its CANONICAL meaning throughout — silent past 24 h. Seeding it
          // independently of the assignment threshold is the point: if either service were still
          // reading this flag, the cases below would fail.
          isInactive: HOURS[deviceId] >= 24,
          hasOpenFailureCycle: false,
        },
      });
    }
  };

  const ticketedDeviceIds = async (): Promise<string[]> =>
    (await prisma.ticket.findMany({ where: { deviceId: { in: ALL } }, select: { deviceId: true } }))
      .map((t) => t.deviceId)
      .sort();

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    creation = new TicketCreationService(prisma);
    recovery = new AutoRecoveryService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-238-' + Date.now() } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-238', companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-238', zoneId } })).plantId;

    for (const deviceId of ALL) {
      await prisma.device.create({ data: { deviceId } });
      await prisma.deviceState.create({
        data: {
          deviceId,
          isInactive: HOURS[deviceId] >= 24,
          inactivityHours: HOURS[deviceId],
          slaBucket: 'CRITICAL',
          eligibleForUptime: true,
          hasOpenFailureCycle: false,
          plantId,
          companyId,
          computedAt: NOW,
        },
      });
    }
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
    // Shared test DB (#156) — hand the key back on its default.
    await setThreshold(DEFAULT_SE_ASSIGNMENT_THRESHOLD_HOURS);
    await prisma.onModuleDestroy();
  });

  beforeEach(resetDevices);

  it('at the shipped default (24 h) behaves exactly as the pre-#238 is_inactive gate did', async () => {
    await setThreshold(24);
    await creation.createForInactiveEligible(NOW);
    expect(await ticketedDeviceIds()).toEqual([DEV_30H, DEV_60H].sort());
  });

  it('raised to 48 h, it holds back a device the dashboards already call Inactive', async () => {
    await setThreshold(48);
    await creation.createForInactiveEligible(NOW);
    // DEV_30H is is_inactive = true and deliberately NOT ticketed: the grace window is the operator's
    // decision, and it has to survive the fact that the KPI still counts the device as down.
    expect(await ticketedDeviceIds()).toEqual([DEV_60H]);
  });

  it('lowered to 12 h, it opens work before a device is counted Inactive at all', async () => {
    await setThreshold(12);
    await creation.createForInactiveEligible(NOW);
    // DEV_18H has is_inactive = false — the whole point of the lower setting.
    expect(await ticketedDeviceIds()).toEqual([DEV_18H, DEV_30H, DEV_60H].sort());
  });

  it('complementarity: a ticket opened below the Inactive line is NOT then handed to auto-recovery', async () => {
    await setThreshold(12);
    await creation.createForInactiveEligible(NOW);

    const before = await prisma.ticket.findMany({ where: { deviceId: DEV_18H } });
    expect(before).toHaveLength(1);

    // The same pass the pipeline runs: recompute → auto-recovery → creation. If auto-recovery were
    // still scanning `is_inactive = false`, DEV_18H (silent 18 h, is_inactive false) would be a
    // candidate here and its brand-new ticket would be closed as a self-healing device.
    // Zone-scoped so the shared test DB's unrelated open tickets (#156) cannot mask or fake the result.
    const result = await recovery.runAutoRecovery({ now: NOW, dryRun: true, zoneId: Number(zoneId) });
    const plan = result.plan ?? [];
    expect(plan.map((p) => p.deviceId)).not.toContain(DEV_18H);
    expect(result.scanned).toBe(0); // nothing in this zone is below the 12 h gate

    const after = await prisma.ticket.findFirstOrThrow({ where: { deviceId: DEV_18H } });
    expect(after.status).toBe('OPEN');
  });

  it('complementarity holds in the other direction too: raising the threshold makes a still-silent device a recovery candidate, not an orphan', async () => {
    // Threshold 48: DEV_30H is below the gate, so auto-recovery may consider it. It is a *candidate*
    // — the ping evidence still decides — but it must not fall outside both scans, which is what an
    // `is_inactive`-based recovery scan would do (is_inactive true ⇒ excluded there, below the
    // threshold ⇒ excluded from creation): an open ticket nothing would ever look at again.
    await setThreshold(48);
    await prisma.deviceState.update({ where: { deviceId: DEV_30H }, data: { hasOpenFailureCycle: true } });
    const cycle = await prisma.failureCycle.create({
      data: { deviceId: DEV_30H, state: 'OPEN', openedAt: new Date(NOW.getTime() - 30 * 3_600_000) },
    });
    await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        failureCycleId: cycle.cycleId,
        deviceId: DEV_30H,
        plantId,
        companyId,
        companyTier: 'GOLD',
        lastStateChangedAt: NOW,
      },
    });

    const result = await recovery.runAutoRecovery({ now: NOW, dryRun: true, zoneId: Number(zoneId) });
    // `scanned` counts the candidates the DB filter returned, scoped to this zone — DEV_30H is the
    // only open ticket here, so a non-zero count is specifically it.
    expect(result.scanned).toBe(1);
  });
});
