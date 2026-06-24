import { PrismaService } from '../src/prisma/prisma.service';
import { TicketCreationService } from '../src/ticketing/ticket-creation.service';

/**
 * Issue 05, slice 6 — the creation gate + duplicate-active invariant (AC#4 gate side, AC#5).
 *
 *  - an inactive but INELIGIBLE device gets no ticket
 *  - an ACTIVE (not-inactive) eligible device gets no ticket
 *  - a second run creates no duplicate (the has_open_failure_cycle filter)
 *  - even with a stale has_open_failure_cycle flag, the I1 active-cycle partial-unique prevents a
 *    second open ticket (no second open ticket for the same device — the real invariant)
 */
const DEV_INELIGIBLE = 9_056_001n;
const DEV_ACTIVE = 9_056_002n;
const DEV_DUP = 9_056_003n;
const DEV_STALE = 9_056_004n;
const ALL = [DEV_INELIGIBLE, DEV_ACTIVE, DEV_DUP, DEV_STALE];

describe('Issue 05 slice 6 — creation gate + duplicate invariant', () => {
  let prisma: PrismaService;
  let service: TicketCreationService;
  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;

  const NOW = new Date(Date.UTC(2026, 5, 20, 12, 0, 0));

  const seedState = (deviceId: bigint, over: { isInactive: boolean; eligible: boolean }) =>
    prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: over.isInactive,
        inactivityHours: over.isInactive ? 30 : 1,
        slaBucket: over.isInactive ? 'CRITICAL' : null,
        eligibleForUptime: over.eligible,
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

    const zone = await prisma.zone.create({ data: { name: 'Z-slice6-' + Date.now() } });
    zoneId = zone.zoneId;
    const company = await prisma.company.create({
      data: { name: 'Co-slice6', companyTier: 'SILVER', companyPriorityRank: 'C' },
    });
    companyId = company.companyId;
    const plant = await prisma.plant.create({ data: { name: 'P-slice6', zoneId } });
    plantId = plant.plantId;

    for (const deviceId of ALL) await prisma.device.create({ data: { deviceId } });
    await seedState(DEV_INELIGIBLE, { isInactive: true, eligible: false });
    await seedState(DEV_ACTIVE, { isInactive: false, eligible: true });
    await seedState(DEV_DUP, { isInactive: true, eligible: true });
    await seedState(DEV_STALE, { isInactive: true, eligible: true });
    // DEV_STALE already has an OPEN cycle, but its state flag is (wrongly) still false.
    await prisma.failureCycle.create({
      data: { deviceId: DEV_STALE, state: 'OPEN', openedAt: NOW },
    });
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

  it('does not ticket an inactive but ineligible device', async () => {
    await service.createForInactiveEligible(NOW);
    expect(await prisma.ticket.count({ where: { deviceId: DEV_INELIGIBLE } })).toBe(0);
  });

  it('does not ticket an active (not-inactive) device', async () => {
    await service.createForInactiveEligible(NOW);
    expect(await prisma.ticket.count({ where: { deviceId: DEV_ACTIVE } })).toBe(0);
  });

  it('creates no duplicate ticket on a second run', async () => {
    // The service acts globally, so DEV_DUP may have been created by an earlier test's call; assert
    // the order-independent end state plus a fresh rerun that creates nothing new.
    await service.createForInactiveEligible(NOW);
    const rerun = await service.createForInactiveEligible(NOW);

    expect(await prisma.ticket.count({ where: { deviceId: DEV_DUP } })).toBe(1);
    expect(await prisma.failureCycle.count({ where: { deviceId: DEV_DUP } })).toBe(1);
    expect(rerun.created).toBe(0);
  });

  it('prevents a second open ticket when the open-cycle flag is stale (I1 backstop)', async () => {
    await service.createForInactiveEligible(NOW);
    // Only the single pre-seeded OPEN cycle exists; no ticket was created for DEV_STALE.
    expect(await prisma.failureCycle.count({ where: { deviceId: DEV_STALE } })).toBe(1);
    expect(await prisma.ticket.count({ where: { deviceId: DEV_STALE } })).toBe(0);
  });
});
