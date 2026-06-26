import type { RequestActor } from '../src/common/request-actor';
import { InstallService } from '../src/ticketing/install.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 33, slice 2 — Install Ticket CSV bulk upload (AC#2, AC#3, AC#5). The CSV is validated
 * all-or-nothing: every row is checked first; if any row is bad, none are created and the failures are
 * returned with 1-based line numbers (no partial corruption). A clean batch creates every ticket under
 * one shared `install_batch_id`. A missing required header column rejects the whole upload.
 */
const DEV_1 = 9_361_001n;
const DEV_2 = 9_361_002n;
const ALL_DEV = [DEV_1, DEV_2];

const ohActor: RequestActor = {
  userId: '33333333-3333-3333-3333-333333333333',
  role: 'OPERATIONS_HEAD',
  actedAsRole: null,
  actingZone: null,
};
const ohScope = { role: 'OPERATIONS_HEAD', zoneId: null };

describe('Issue 33 slice 2 — InstallService.uploadCsv', () => {
  let prisma: PrismaService;
  let service: InstallService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let veh1: string;
  let veh2: string;

  const NOW = new Date(Date.UTC(2026, 5, 26, 10, 0, 0));

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new InstallService(prisma);

    const stamp = Date.now();
    zoneId = (await prisma.zone.create({ data: { name: 'Z-csv-' + stamp } })).zoneId;
    companyId = (
      await prisma.company.create({
        data: { name: 'Co-csv-' + stamp, companyTier: 'SILVER', companyPriorityRank: 'C' },
      })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-csv', zoneId } })).plantId;
    veh1 = 'CSV-V1-' + stamp;
    veh2 = 'CSV-V2-' + stamp;
    await prisma.vehicle.create({ data: { vehicleNo: veh1, plantId, companyId } });
    await prisma.vehicle.create({ data: { vehicleNo: veh2, plantId, companyId } });
    await prisma.device.create({ data: { deviceId: DEV_1, deviceType: 'GPS-X' } });
    await prisma.device.create({ data: { deviceId: DEV_2, deviceType: 'GPS-X' } });
  });

  afterAll(async () => {
    // Scope cleanup to THIS spec's company so parallel specs can't delete each other's audit rows.
    const ids = (await prisma.ticket.findMany({ where: { workType: 'INSTALL', companyId }, select: { ticketId: true } })).map((t) => t.ticketId);
    if (ids.length > 0) {
      await prisma.auditLog.deleteMany({ where: { entityType: 'tickets', entityId: { in: ids } } });
      await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ids } } });
      await prisma.ticket.deleteMany({ where: { ticketId: { in: ids } } });
    }
    await prisma.device.deleteMany({ where: { deviceId: { in: ALL_DEV } } });
    await prisma.vehicle.deleteMany({ where: { vehicleNo: { in: [veh1, veh2] } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  const header = 'vehicle_no,plant_id,company_id,device_type,device_id,sim_id,target_date,notes';

  it('creates every ticket under one shared batch id for a clean CSV', async () => {
    const csv = [
      header,
      `${veh1},${plantId},${companyId},GPS-X,${DEV_1},SIM-1,2026-07-01,row one`,
      `${veh2},${plantId},${companyId},GPS-X,${DEV_2},,,`,
    ].join('\n');

    const out = await service.uploadCsv(csv, ohScope, ohActor, NOW);
    expect(out.result).toBe('OK');
    if (out.result !== 'OK') return;
    expect(out.ticketIds).toHaveLength(2);

    const tickets = await prisma.ticket.findMany({ where: { installBatchId: out.batchId } });
    expect(tickets).toHaveLength(2);
    expect(tickets.every((t) => t.workType === 'INSTALL' && t.status === 'REQUESTED')).toBe(true);
    expect(tickets.every((t) => t.installTriggerSource === 'MANUAL_OPERATIONS')).toBe(true);
    expect(tickets.every((t) => t.createdByRole === 'OPERATIONS_HEAD')).toBe(true);

    const audits = await prisma.auditLog.findMany({
      where: { entityType: 'tickets', entityId: { in: out.ticketIds }, action: 'INSTALL_TICKET_CREATED' },
    });
    expect(audits).toHaveLength(2);

    // clean up this batch so the bad-row test starts from a known empty state
    await prisma.auditLog.deleteMany({ where: { entityType: 'tickets', entityId: { in: out.ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: out.ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: out.ticketIds } } });
  });

  it('creates nothing and reports a line number when one row is bad (no partial corruption)', async () => {
    const csv = [
      header,
      `${veh1},${plantId},${companyId},GPS-X,${DEV_1},,,`, // line 2 — valid
      `NOPE-VEHICLE,${plantId},${companyId},GPS-X,${DEV_2},,,`, // line 3 — bad vehicle
    ].join('\n');

    const out = await service.uploadCsv(csv, ohScope, ohActor, NOW);
    expect(out.result).toBe('INVALID');
    if (out.result !== 'INVALID') return;
    expect(out.errors).toEqual([{ line: 3, code: 'VEHICLE_NOT_FOUND' }]);

    // Nothing was created — the valid line 2 must NOT have produced a ticket.
    const leaked = await prisma.ticket.findMany({ where: { workType: 'INSTALL', companyId } });
    expect(leaked).toHaveLength(0);
  });

  it('reports an invalid numeric cell with its line number', async () => {
    const csv = [
      header,
      `${veh1},not-a-number,${companyId},GPS-X,${DEV_1},,,`,
    ].join('\n');
    const out = await service.uploadCsv(csv, ohScope, ohActor, NOW);
    expect(out.result).toBe('INVALID');
    if (out.result !== 'INVALID') return;
    expect(out.errors[0]).toEqual({ line: 2, code: 'INVALID_NUMBER' });
  });

  it('rejects a CSV whose header is missing a required column', async () => {
    const csv = ['vehicle_no,plant_id,company_id,device_id', `${veh1},${plantId},${companyId},${DEV_1}`].join('\n');
    const out = await service.uploadCsv(csv, ohScope, ohActor, NOW);
    expect(out.result).toBe('INVALID');
    if (out.result !== 'INVALID') return;
    expect(out.errors[0].code).toBe('MISSING_REQUIRED_FIELD');
    expect(out.errors[0].field).toBe('device_type');
  });
});
