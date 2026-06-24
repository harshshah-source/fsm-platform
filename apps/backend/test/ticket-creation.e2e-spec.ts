import { PrismaService } from '../src/prisma/prisma.service';
import { TicketCreationService } from '../src/ticketing/ticket-creation.service';

/**
 * Issue 05, slice 5 — TicketCreationService opens the Troubleshoot spine (AC#3).
 *
 * For a device whose `device_states` row is newly inactive AND eligible AND has no open episode, it
 * creates exactly one `failure_cycle` (OPEN) and its one parented `ticket`
 * (work_type=TROUBLESHOOT, status=OPEN, company_tier denormalised), then flips
 * `has_open_failure_cycle` on the state row. One Troubleshoot Ticket per device.
 */
const DEVICE = 9_055_001n;

describe('Issue 05 slice 5 — TicketCreationService', () => {
  let prisma: PrismaService;
  let service: TicketCreationService;
  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let vehicleId: bigint;

  const NOW = new Date(Date.UTC(2026, 5, 20, 12, 0, 0));

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new TicketCreationService(prisma);

    const zone = await prisma.zone.create({ data: { name: 'Z-slice5-' + Date.now() } });
    zoneId = zone.zoneId;
    const company = await prisma.company.create({
      data: { name: 'Co-slice5', companyTier: 'GOLD', companyPriorityRank: 'B' },
    });
    companyId = company.companyId;
    const plant = await prisma.plant.create({ data: { name: 'P-slice5', zoneId } });
    plantId = plant.plantId;
    const vehicle = await prisma.vehicle.create({
      data: { vehicleNo: 'VH-slice5-' + Date.now(), plantId, companyId },
    });
    vehicleId = vehicle.vehicleId;
    await prisma.device.create({ data: { deviceId: DEVICE, currentVehicleId: vehicleId } });
    await prisma.deviceState.create({
      data: {
        deviceId: DEVICE,
        latestGpsDatetime: new Date(NOW.getTime() - 30 * 3_600_000),
        isInactive: true,
        inactivityHours: 30,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        hasOpenFailureCycle: false,
        vehicleId,
        plantId,
        companyId,
        computedAt: NOW,
      },
    });
  });

  afterAll(async () => {
    await prisma.ticketEvent.deleteMany({ where: { ticket: { deviceId: DEVICE } } });
    await prisma.ticket.deleteMany({ where: { deviceId: DEVICE } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: DEVICE } });
    await prisma.deviceState.deleteMany({ where: { deviceId: DEVICE } });
    await prisma.device.deleteMany({ where: { deviceId: DEVICE } });
    await prisma.vehicle.deleteMany({ where: { vehicleId } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('opens one OPEN Failure Cycle and one parented TROUBLESHOOT ticket', async () => {
    const result = await service.createForInactiveEligible(NOW);
    expect(result.created).toBe(1);

    const cycles = await prisma.failureCycle.findMany({ where: { deviceId: DEVICE } });
    expect(cycles).toHaveLength(1);
    expect(cycles[0].state).toBe('OPEN');

    const tickets = await prisma.ticket.findMany({ where: { deviceId: DEVICE } });
    expect(tickets).toHaveLength(1);
    const t = tickets[0];
    expect(t.workType).toBe('TROUBLESHOOT');
    expect(t.status).toBe('OPEN');
    expect(t.failureCycleId).toBe(cycles[0].cycleId);
    expect(t.plantId).toBe(plantId);
    expect(t.companyId).toBe(companyId);
    expect(t.companyTier).toBe('GOLD');
    expect(t.vehicleId).toBe(vehicleId);
  });

  it('flips has_open_failure_cycle on the device state', async () => {
    await service.createForInactiveEligible(NOW);
    const state = await prisma.deviceState.findUnique({ where: { deviceId: DEVICE } });
    expect(state!.hasOpenFailureCycle).toBe(true);
  });
});
