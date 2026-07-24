import { PrismaService } from '../src/prisma/prisma.service';
import { TicketCreationService } from '../src/ticketing/ticket-creation.service';

/**
 * Issue 157, Slice 3 — a newly-created Troubleshoot Ticket stamps `tickets.company_tier` with the
 * EFFECTIVE tier (an ACTIVE zone-scoped override, when one applies), not the company's plain global
 * tier — the design's point 2 ("creation already knows the plant → zone"). Q-B (live reads only)
 * is unaffected: this is a snapshot taken AT CREATION, not a retroactive re-stamp of existing tickets.
 */
const DEVICE = String(9_401_000n);

describe('Issue 157 Slice 3 — TicketCreationService stamps the effective tier', () => {
  let prisma: PrismaService;
  let service: TicketCreationService;
  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;

  const NOW = new Date('2026-07-23T06:00:00Z');

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new TicketCreationService(prisma);

    const zone = await prisma.zone.create({ data: { name: 'Z157create-' + Date.now() } });
    zoneId = zone.zoneId;
    const company = await prisma.company.create({
      data: { name: 'Co157create-' + Date.now(), companyTier: 'GOLD', companyPriorityRank: 'B' },
    });
    companyId = company.companyId;
    const plant = await prisma.plant.create({ data: { name: 'P157create-' + Date.now(), zoneId } });
    plantId = plant.plantId;
    await prisma.device.create({ data: { deviceId: DEVICE } });
    await prisma.deviceState.create({
      data: {
        deviceId: DEVICE,
        latestGpsDatetime: new Date(NOW.getTime() - 30 * 3_600_000),
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
    await prisma.companyTierOverride.create({
      data: {
        companyId,
        zoneId,
        tier: 'PLATINUM',
        reason: 'Ticket-creation stamp fixture — company is globally GOLD, overridden here',
        expiresAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
        status: 'ACTIVE',
      },
    });
  });

  afterAll(async () => {
    await prisma.ticketEvent.deleteMany({ where: { ticket: { deviceId: DEVICE } } });
    await prisma.ticket.deleteMany({ where: { deviceId: DEVICE } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: DEVICE } });
    await prisma.deviceState.deleteMany({ where: { deviceId: DEVICE } });
    await prisma.device.deleteMany({ where: { deviceId: DEVICE } });
    await prisma.companyTierOverride.deleteMany({ where: { companyId } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it("stamps the new ticket's company_tier with the ACTIVE override's tier, not the company's global GOLD", async () => {
    const result = await service.createForInactiveEligible(NOW);
    expect(result.created).toBe(1);

    const ticket = await prisma.ticket.findFirstOrThrow({ where: { deviceId: DEVICE } });
    expect(ticket.companyTier).toBe('PLATINUM');

    const company = await prisma.company.findUniqueOrThrow({ where: { companyId } });
    expect(company.companyTier).toBe('GOLD');
  });
});
