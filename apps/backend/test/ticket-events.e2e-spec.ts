import { PrismaService } from '../src/prisma/prisma.service';
import { TicketCreationService } from '../src/ticketing/ticket-creation.service';

/**
 * Issue 07, slice A — the `ticket_events` lifecycle timeline (LLD schema D6). TicketCreation writes
 * the opening transition (→ OPEN) so the Detail Drawer's Lifecycle tab has real data from event one.
 * Later issues append their transitions; the table is append-only.
 */
const DEVICE = 9_071_001n;

describe('Issue 07 slice A — ticket_events opening transition', () => {
  let prisma: PrismaService;
  let service: TicketCreationService;
  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;

  const NOW = new Date(Date.UTC(2026, 5, 20, 12, 0, 0));

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new TicketCreationService(prisma);

    const zone = await prisma.zone.create({ data: { name: 'Z-evt-' + Date.now() } });
    zoneId = zone.zoneId;
    const company = await prisma.company.create({
      data: { name: 'Co-evt', companyTier: 'GOLD', companyPriorityRank: 'B' },
    });
    companyId = company.companyId;
    const plant = await prisma.plant.create({ data: { name: 'P-evt', zoneId } });
    plantId = plant.plantId;
    await prisma.device.create({ data: { deviceId: DEVICE } });
    await prisma.deviceState.create({
      data: {
        deviceId: DEVICE,
        isInactive: true,
        inactivityHours: 30,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        plantId,
        companyId,
        computedAt: NOW,
      },
    });
  });

  afterAll(async () => {
    const tickets = await prisma.ticket.findMany({ where: { deviceId: DEVICE } });
    await prisma.ticketEvent.deleteMany({
      where: { ticketId: { in: tickets.map((t) => t.ticketId) } },
    });
    await prisma.ticket.deleteMany({ where: { deviceId: DEVICE } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: DEVICE } });
    await prisma.deviceState.deleteMany({ where: { deviceId: DEVICE } });
    await prisma.device.deleteMany({ where: { deviceId: DEVICE } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('records a single OPEN event (from_state null, system actor) on ticket creation', async () => {
    await service.createForInactiveEligible(NOW);
    const ticket = await prisma.ticket.findFirstOrThrow({ where: { deviceId: DEVICE } });

    const events = await prisma.ticketEvent.findMany({ where: { ticketId: ticket.ticketId } });
    expect(events).toHaveLength(1);
    expect(events[0].fromState).toBeNull();
    expect(events[0].toState).toBe('OPEN');
    expect(events[0].actorId).toBeNull(); // system-generated creation
  });
});
