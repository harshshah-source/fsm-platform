import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { VehicleUnavailabilityService } from '../src/ticketing/vehicle-unavailability.service';

/**
 * Issue 28 slice 2 — Vehicle Unavailability Report + dual SLA clocks. Filing pauses the primary SLA
 * (pause_reason = VEHICLE_UNAVAILABLE) and stores the expected-availability date. The ZM list exposes
 * BOTH clocks: the primary (pausable, effective) and the secondary (true elapsed from opened_at, never
 * pauses). The ZM can confirm/edit the date and manually resume the SLA.
 */
const NS = Date.now();
const NOW = new Date('2026-06-25T12:00:00Z');
const OPENED = new Date('2026-06-25T10:00:00Z'); // 2h before NOW
const LATER = new Date('2026-06-25T13:00:00Z'); // NOW + 1h

describe('Issue 28 slice 2 — Vehicle Unavailability service', () => {
  let prisma: PrismaService;
  let svc: VehicleUnavailabilityService;
  let zoneA: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let se: string;
  let deviceId: bigint;
  let cycleId: string;
  let ticketId: string;
  const userIds: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new VehicleUnavailabilityService(prisma);

    zoneA = (await prisma.zone.create({ data: { name: 'Z-vuA-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-vu-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-vu-' + NS, zoneId: zoneA } })).plantId;
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'VU SE ' + NS, role: 'SERVICE_ENGINEER', phone: 'vu-' + tag, email: `${tag}-${NS}@vu.test`, zoneId: zoneA },
    });
    se = u.userId;
    userIds.push(se);
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId: zoneA, dailyCapacity: 10 } });

    deviceId = BigInt(9_600_000_000 + (NS % 100_000));
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: OPENED } });
    cycleId = cycle.cycleId;
    const ticket = await prisma.ticket.create({
      data: { workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: cycleId, deviceId, plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: OPENED },
    });
    ticketId = ticket.ticketId;
  });

  afterAll(async () => {
    await prisma.vehicleUnavailabilityReport.deleteMany({ where: { ticketId } });
    await prisma.ticket.deleteMany({ where: { ticketId } });
    await prisma.failureCycle.deleteMany({ where: { deviceId } });
    await prisma.device.deleteMany({ where: { deviceId } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId: zoneA } });
    await prisma.onModuleDestroy();
  });

  let reportId: string;

  it('an SE files a report and the primary SLA pauses with VEHICLE_UNAVAILABLE', async () => {
    const out = await svc.fileReport(
      {
        ticketId,
        seId: se,
        reasonCode: 'VEHICLE_ON_TRIP',
        transporterContacted: true,
        expectedFrom: new Date('2026-06-26T09:00:00Z'),
        notes: 'on a trip',
      },
      { userId: se, role: 'SERVICE_ENGINEER', zoneId: Number(zoneA) },
      NOW,
    );
    expect(out.result).toBe('OK');
    reportId = out.id!;
    const cycle = await prisma.failureCycle.findUniqueOrThrow({ where: { cycleId } });
    expect(cycle.slaPaused).toBe(true);
    expect(cycle.slaPauseReason).toBe('VEHICLE_UNAVAILABLE');
  });

  it('forbids a different SE from filing on the ticket', async () => {
    const out = await svc.fileReport(
      { ticketId, seId: se, reasonCode: 'OTHER', transporterContacted: false, expectedFrom: NOW },
      { userId: randomUUID(), role: 'SERVICE_ENGINEER', zoneId: Number(zoneA) },
      NOW,
    );
    expect(out.result).toBe('FORBIDDEN');
  });

  it('the ZM list exposes both SLA clocks; primary (paused) < secondary (true elapsed)', async () => {
    const rows = await svc.listForZone({ role: 'ZONAL_MANAGER', zoneId: Number(zoneA) }, LATER);
    const row = rows.find((r) => r.ticketId === ticketId)!;
    expect(row.reasonCode).toBe('VEHICLE_ON_TRIP');
    expect(row.transporterContacted).toBe(true);
    expect(row.slaPaused).toBe(true);
    // opened 3h before LATER → secondary 10800s; paused 1h → primary 7200s.
    expect(row.secondarySlaSeconds).toBe(10800);
    expect(row.primarySlaSeconds).toBe(7200);
    expect(row.primarySlaSeconds).toBeLessThan(row.secondarySlaSeconds);
  });

  it('the ZM confirms a new expected date', async () => {
    const out = await svc.confirmDate(reportId, new Date('2026-06-27T09:00:00Z'), { userId: 'zm', role: 'ZONAL_MANAGER', zoneId: Number(zoneA) });
    expect(out.result).toBe('OK');
    const row = await prisma.vehicleUnavailabilityReport.findUniqueOrThrow({ where: { id: BigInt(reportId) } });
    expect(row.expectedFrom.toISOString()).toBe('2026-06-27T09:00:00.000Z');
  });

  it('the ZM manually resumes the SLA and the report resolves', async () => {
    const out = await svc.resumeSla(reportId, { userId: 'zm', role: 'ZONAL_MANAGER', zoneId: Number(zoneA) }, LATER);
    expect(out.result).toBe('OK');
    const cycle = await prisma.failureCycle.findUniqueOrThrow({ where: { cycleId } });
    expect(cycle.slaPaused).toBe(false);
    expect(Number(cycle.slaAccumulatedPauseSeconds)).toBe(3600); // paused NOW→LATER = 1h
    const row = await prisma.vehicleUnavailabilityReport.findUniqueOrThrow({ where: { id: BigInt(reportId) } });
    expect(row.status).toBe('RESOLVED');
  });
});
