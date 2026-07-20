import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';

/**
 * #130 L2 regression lock — the recommender already re-reads `device_departures` directly
 * (`recommender.service.ts:113`, `device: { departures: { none: { restoredAt: null } } }`), unlike
 * the ticket-creation gate that trusted the derived `is_departed` flag (the run-65 gap, fixed
 * alongside this test). This pins that behaviour so a future refactor can't silently swap the ledger
 * re-read back to a flag check: a ticket for a device with an ACTIVE departure is excluded from the
 * run EVEN WHEN `device_states.is_departed` is (wrongly) false — the exact corrupted shape run-65 left
 * behind. If this regresses to `isDeparted: false` on `device_states`, this test must fail.
 */
const NS = Date.now();

describe('#130 L2 — RecommenderService re-reads device_departures, not the derived flag', () => {
  let prisma: PrismaService;
  let rec: RecommenderService;
  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;

  const NOW = new Date('2026-07-20T06:00:00Z');
  const DEV_DEPARTED_STALE_FLAG = String(9_310_000_000 + (NS % 100_000));
  const DEV_NORMAL = String(9_310_000_001 + (NS % 100_000));

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    rec = new RecommenderService(prisma, new CandidateSelectionService(prisma));

    for (const [component, weight] of [
      ['company_priority_rank', 0.4],
      ['dispatch_urgency', 0.3],
      ['repeat_failure_penalty', 0.2],
      ['distance', 0.1],
    ] as const) {
      await prisma.priorityRuleConfig.upsert({
        where: { weightSetRef_component: { weightSetRef: 'default', component } },
        create: { weightSetRef: 'default', component, weight, active: true },
        update: { weight, active: true },
      });
    }

    const zone = await prisma.zone.create({ data: { name: 'Z-130L2rec-' + NS } });
    zoneId = zone.zoneId;
    const company = await prisma.company.create({
      data: { name: 'Co-130L2rec', companyTier: 'GOLD', companyPriorityRank: 'B' },
    });
    companyId = company.companyId;
    const plant = await prisma.plant.create({ data: { name: 'P-130L2rec', zoneId } });
    plantId = plant.plantId;

    // Deliberately NO service engineer seeded — irrelevant to this test: a departed-device ticket
    // must never even ENTER the processing loop (ticketsConsidered), regardless of SE availability.
    for (const deviceId of [DEV_DEPARTED_STALE_FLAG, DEV_NORMAL]) {
      await prisma.device.create({ data: { deviceId } });
      await prisma.deviceState.create({
        data: {
          deviceId,
          isInactive: true,
          slaBucket: 'CRITICAL',
          eligibleForUptime: true,
          hasOpenFailureCycle: true,
          isDeparted: false, // stale/wrong on the departed device — the run-65 corruption shape
          latestGpsDatetime: new Date(NOW.getTime() - 30 * 60_000),
          plantId,
          companyId,
          computedAt: NOW,
        },
      });
      const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
      await prisma.ticket.create({
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
    }

    // The ledger's truth: DEV_DEPARTED_STALE_FLAG has an ACTIVE departure, despite is_departed=false.
    await prisma.deviceDeparture.create({
      data: {
        deviceId: DEV_DEPARTED_STALE_FLAG,
        observedStatus: 'UNDEPLOYED',
        reason: 'SOURCE_STATUS',
        departedAt: new Date(NOW.getTime() - 3_600_000),
        restoredAt: null,
      },
    });
  });

  afterAll(async () => {
    const deviceIds = [DEV_DEPARTED_STALE_FLAG, DEV_NORMAL];
    await prisma.recommendation.deleteMany({ where: { ticket: { deviceId: { in: deviceIds } } } });
    await prisma.ticket.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.deviceDeparture.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('never enters the processing loop for a device with an active departure, even when is_departed is (wrongly) false', async () => {
    const summary = await rec.runForZone(zoneId, { now: NOW });

    // Only the normal (non-departed) ticket should have been considered.
    expect(summary.ticketsConsidered).toBe(1);

    const departedTicket = await prisma.ticket.findFirstOrThrow({ where: { deviceId: DEV_DEPARTED_STALE_FLAG } });
    const rows = await prisma.recommendation.findMany({ where: { ticketId: departedTicket.ticketId } });
    expect(rows).toHaveLength(0); // no SUGGESTED, no UNASSIGNABLE — filtered out before the loop
  });
});
