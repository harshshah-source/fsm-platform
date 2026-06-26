import type { RequestActor } from '../src/common/request-actor';
import { InstallService } from '../src/ticketing/install.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 33, slice 1 — Install Ticket single-create (AC#1, AC#4, AC#5). A manager (ZM own-zone /
 * CSM scope / OH all-zones) manually creates one Install Ticket: work_type=INSTALL, status REQUESTED,
 * `install_trigger_source=MANUAL_OPERATIONS`, `created_by` + `created_by_role`, a full audit row, and
 * the opening lifecycle event. Per-row validation rejects a missing vehicle/device/plant/company, a
 * vehicle that already has an active device, and a plant outside the creator's zone authority.
 */
const DEV_FREE = 9_360_001n; // unmapped device, installable
const DEV_MAPPED = 9_360_002n; // already actively fitted to a vehicle
const ALL_DEV = [DEV_FREE, DEV_MAPPED];

const zmActor: RequestActor = {
  userId: '11111111-1111-1111-1111-111111111111',
  role: 'ZONAL_MANAGER',
  actedAsRole: null,
  actingZone: null,
};
const ohActor: RequestActor = {
  userId: '33333333-3333-3333-3333-333333333333',
  role: 'OPERATIONS_HEAD',
  actedAsRole: null,
  actingZone: null,
};

describe('Issue 33 slice 1 — InstallService.createSingle', () => {
  let prisma: PrismaService;
  let service: InstallService;

  let zoneA: bigint;
  let zoneB: bigint;
  let companyId: bigint;
  let plantA: bigint; // in zoneA
  let plantB: bigint; // in zoneB
  let freeVehicle: bigint; // no active device
  let mappedVehicle: bigint; // already has DEV_MAPPED
  let freeVehicleNo: string;
  let mappedVehicleNo: string;

  const NOW = new Date(Date.UTC(2026, 5, 26, 9, 0, 0));

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new InstallService(prisma);

    const stamp = Date.now();
    zoneA = (await prisma.zone.create({ data: { name: 'Z-inst-A-' + stamp } })).zoneId;
    zoneB = (await prisma.zone.create({ data: { name: 'Z-inst-B-' + stamp } })).zoneId;
    companyId = (
      await prisma.company.create({
        data: { name: 'Co-inst-' + stamp, companyTier: 'GOLD', companyPriorityRank: 'B' },
      })
    ).companyId;
    plantA = (await prisma.plant.create({ data: { name: 'P-inst-A', zoneId: zoneA } })).plantId;
    plantB = (await prisma.plant.create({ data: { name: 'P-inst-B', zoneId: zoneB } })).plantId;

    freeVehicleNo = 'INST-FREE-' + stamp;
    mappedVehicleNo = 'INST-MAPPED-' + stamp;
    freeVehicle = (
      await prisma.vehicle.create({ data: { vehicleNo: freeVehicleNo, plantId: plantA, companyId } })
    ).vehicleId;
    mappedVehicle = (
      await prisma.vehicle.create({ data: { vehicleNo: mappedVehicleNo, plantId: plantA, companyId } })
    ).vehicleId;

    await prisma.device.create({ data: { deviceId: DEV_FREE, deviceType: 'GPS-X' } });
    // DEV_MAPPED is actively fitted to mappedVehicle (denormalised current fitment).
    await prisma.device.create({
      data: { deviceId: DEV_MAPPED, deviceType: 'GPS-X', currentVehicleId: mappedVehicle },
    });
  });

  // Scope cleanup to THIS spec's company so parallel specs can't delete each other's audit rows.
  const cleanupInstallTickets = async (cid: bigint): Promise<void> => {
    const ids = (await prisma.ticket.findMany({ where: { workType: 'INSTALL', companyId: cid }, select: { ticketId: true } })).map((t) => t.ticketId);
    if (ids.length > 0) {
      await prisma.auditLog.deleteMany({ where: { entityType: 'tickets', entityId: { in: ids } } });
      await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ids } } });
      await prisma.ticket.deleteMany({ where: { ticketId: { in: ids } } });
    }
  };

  afterAll(async () => {
    await cleanupInstallTickets(companyId);
    await prisma.device.deleteMany({ where: { deviceId: { in: ALL_DEV } } });
    await prisma.vehicle.deleteMany({ where: { vehicleId: { in: [freeVehicle, mappedVehicle] } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [plantA, plantB] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: [zoneA, zoneB] } } });
    await prisma.onModuleDestroy();
  });

  const baseRow = () => ({
    vehicleNo: freeVehicleNo,
    plantId: plantA,
    companyId,
    deviceType: 'GPS-X',
    deviceId: DEV_FREE,
    simId: 'SIM-001',
    targetDate: new Date(Date.UTC(2026, 5, 30, 0, 0, 0)),
    notes: 'first fitment',
  });

  it('creates an Install Ticket: REQUESTED, MANUAL_OPERATIONS, created_by/role, audit + event', async () => {
    const out = await service.createSingle(
      baseRow(),
      { role: 'ZONAL_MANAGER', zoneId: Number(zoneA) },
      zmActor,
      NOW,
    );
    expect(out.result).toBe('OK');
    if (out.result !== 'OK') return;

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: out.ticket.ticketId } });
    expect(ticket.workType).toBe('INSTALL');
    expect(ticket.status).toBe('REQUESTED');
    expect(ticket.failureCycleId).toBeNull();
    expect(ticket.installTriggerSource).toBe('MANUAL_OPERATIONS');
    expect(ticket.createdBy).toBe(zmActor.userId);
    expect(ticket.createdByRole).toBe('ZONAL_MANAGER');
    expect(ticket.companyTier).toBe('GOLD');
    expect(ticket.deviceId).toBe(DEV_FREE);
    expect(ticket.vehicleId).toBe(freeVehicle);
    expect(ticket.installSimId).toBe('SIM-001');
    expect(ticket.installNotes).toBe('first fitment');

    const event = await prisma.ticketEvent.findFirstOrThrow({ where: { ticketId: ticket.ticketId } });
    expect(event.fromState).toBeNull();
    expect(event.toState).toBe('REQUESTED');

    const audit = await prisma.auditLog.findMany({
      where: { entityType: 'tickets', entityId: ticket.ticketId, action: 'INSTALL_TICKET_CREATED' },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0].actorRole).toBe('ZONAL_MANAGER');
  });

  it('rejects a missing vehicle, plant, company, and device', async () => {
    const noVehicle = await service.createSingle(
      { ...baseRow(), vehicleNo: 'NOPE-VEHICLE' },
      { role: 'OPERATIONS_HEAD', zoneId: null },
      ohActor,
      NOW,
    );
    expect(noVehicle).toEqual({ result: 'ERROR', code: 'VEHICLE_NOT_FOUND' });

    const noPlant = await service.createSingle(
      { ...baseRow(), plantId: 999_999_999n },
      { role: 'OPERATIONS_HEAD', zoneId: null },
      ohActor,
      NOW,
    );
    expect(noPlant).toEqual({ result: 'ERROR', code: 'PLANT_NOT_FOUND' });

    const noCompany = await service.createSingle(
      { ...baseRow(), companyId: 999_999_999n },
      { role: 'OPERATIONS_HEAD', zoneId: null },
      ohActor,
      NOW,
    );
    expect(noCompany).toEqual({ result: 'ERROR', code: 'COMPANY_NOT_FOUND' });

    const noDevice = await service.createSingle(
      { ...baseRow(), deviceId: 8_888_888n },
      { role: 'OPERATIONS_HEAD', zoneId: null },
      ohActor,
      NOW,
    );
    expect(noDevice).toEqual({ result: 'ERROR', code: 'DEVICE_NOT_FOUND' });
  });

  it('rejects a vehicle that already has an active device, and an already-mapped device', async () => {
    const vehMapped = await service.createSingle(
      { ...baseRow(), vehicleNo: mappedVehicleNo },
      { role: 'OPERATIONS_HEAD', zoneId: null },
      ohActor,
      NOW,
    );
    expect(vehMapped).toEqual({ result: 'ERROR', code: 'VEHICLE_ALREADY_MAPPED' });

    const devMapped = await service.createSingle(
      { ...baseRow(), deviceId: DEV_MAPPED },
      { role: 'OPERATIONS_HEAD', zoneId: null },
      ohActor,
      NOW,
    );
    expect(devMapped).toEqual({ result: 'ERROR', code: 'DEVICE_ALREADY_MAPPED' });
  });

  it('enforces zone authority: ZM cannot create for a plant outside its zone; OH/CSM can', async () => {
    const zmOtherZone = await service.createSingle(
      { ...baseRow(), plantId: plantB },
      { role: 'ZONAL_MANAGER', zoneId: Number(zoneA) },
      zmActor,
      NOW,
    );
    expect(zmOtherZone).toEqual({ result: 'ERROR', code: 'ZONE_FORBIDDEN' });

    // OH is unrestricted — same plant in zoneB succeeds (needs a fresh free vehicle in zoneB).
    const stamp = Date.now();
    const vehB = await prisma.vehicle.create({
      data: { vehicleNo: 'INST-B-' + stamp, plantId: plantB, companyId },
    });
    const devB = 9_360_003n;
    await prisma.device.create({ data: { deviceId: devB, deviceType: 'GPS-X' } });

    const ohOk = await service.createSingle(
      { ...baseRow(), vehicleNo: vehB.vehicleNo, plantId: plantB, deviceId: devB },
      { role: 'OPERATIONS_HEAD', zoneId: null },
      ohActor,
      NOW,
    );
    expect(ohOk.result).toBe('OK');

    if (ohOk.result === 'OK') {
      await prisma.auditLog.deleteMany({ where: { entityType: 'tickets', entityId: ohOk.ticket.ticketId } });
      await prisma.ticketEvent.deleteMany({ where: { ticketId: ohOk.ticket.ticketId } });
      await prisma.ticket.deleteMany({ where: { ticketId: ohOk.ticket.ticketId } });
    }
    await prisma.device.deleteMany({ where: { deviceId: devB } });
    await prisma.vehicle.deleteMany({ where: { vehicleId: vehB.vehicleId } });
  });
});
