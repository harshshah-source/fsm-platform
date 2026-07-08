import { AuditService } from '../src/audit/audit.service';
import { DeviceStateService } from '../src/device-state/device-state.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { SettingsService } from '../src/settings/settings.service';
import { TicketCreationService } from '../src/ticketing/ticket-creation.service';

/**
 * Issue 112 acceptance — the activation runbook end-to-end, minus AutoPlant: with
 * `eligibility_mode = all-deployed`, a silent device on a DEPLOYED vehicle and an EMPTY
 * `pgi_history` flows recompute → ticket creation into one OPEN TROUBLESHOOT ticket.
 * This is exactly the flow that produced "tickets: 0, by construction" in the 2026-07-07
 * production validation.
 */
const DEVICE = String(9_112_101n);

describe('Issue 112 acceptance — all-deployed mode lights up ticket creation', () => {
  let prisma: PrismaService;
  let deviceState: DeviceStateService;
  let tickets: TicketCreationService;
  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let vehicleId: bigint;

  const NOW = new Date(Date.UTC(2026, 6, 7, 12, 0, 0));
  const SILENT_SINCE = new Date(NOW.getTime() - 30 * 3600 * 1000); // 30h > 24h threshold

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    const settings = new SettingsService(prisma, new AuditService(prisma));
    await settings.seedDefaults();
    deviceState = new DeviceStateService(prisma, settings);
    tickets = new TicketCreationService(prisma);

    const zone = await prisma.zone.create({ data: { name: 'Z-112acc-' + Date.now() } });
    zoneId = zone.zoneId;
    const company = await prisma.company.create({
      data: { name: 'Co-112acc', companyTier: 'GOLD', companyPriorityRank: 'B' },
    });
    companyId = company.companyId;
    const plant = await prisma.plant.create({ data: { name: 'P-112acc', zoneId } });
    plantId = plant.plantId;
    const vehicle = await prisma.vehicle.create({
      data: { vehicleNo: 'VH-112-ACC', plantId, companyId, status: 'DEPLOYED' },
    });
    vehicleId = vehicle.vehicleId;
    await prisma.device.create({ data: { deviceId: DEVICE, currentVehicleId: vehicleId } });
    // The last ping arrived 30h ago (normally maintained at ingest); no pgi_history row exists.
    await prisma.deviceState.create({
      data: { deviceId: DEVICE, latestGpsDatetime: SILENT_SINCE, computedAt: SILENT_SINCE },
    });

    await prisma.systemSetting.upsert({
      where: { key: 'eligibility_mode' },
      create: { key: 'eligibility_mode', value: 'all-deployed' },
      update: { value: 'all-deployed' },
    });
  });

  afterAll(async () => {
    await prisma.systemSetting.upsert({
      where: { key: 'eligibility_mode' },
      create: { key: 'eligibility_mode', value: 'pgi' },
      update: { value: 'pgi' },
    });
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

  it('recompute → createForInactiveEligible opens one TROUBLESHOOT ticket with no PGI data', async () => {
    await deviceState.recompute(NOW);

    const state = await prisma.deviceState.findUnique({ where: { deviceId: DEVICE } });
    expect(state!.isInactive).toBe(true);
    expect(state!.eligibleForUptime).toBe(true); // no pgi_history row anywhere near this device

    const { created } = await tickets.createForInactiveEligible(NOW);
    expect(created).toBeGreaterThanOrEqual(1); // service is fleet-wide; ≥ our device

    const ticket = await prisma.ticket.findFirst({ where: { deviceId: DEVICE } });
    expect(ticket).not.toBeNull();
    expect(ticket!.workType).toBe('TROUBLESHOOT');
    expect(ticket!.status).toBe('OPEN');
    expect(ticket!.plantId).toBe(plantId);
    expect(ticket!.companyTier).toBe('GOLD');
  });
});
