import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { PlantEligibleFloatingSeService } from '../src/org/plant-eligible-floating-se.service';
import { SharedPoolService } from '../src/shared-pool/shared-pool.service';

/**
 * Issue 12, slice 4 — Floating-SE Shared Pool coverage (AC#3/#5 for territory). A Floating SE's
 * covered plants come from the `plant_eligible_floating_se` MV (territory union), not se_coverage.
 * The pool shows open tickets at plants inside the SE's district territory and never plants outside.
 */
const NS = Date.now();

describe('Issue 12 slice 4 — Floating-SE territory coverage in the Shared Pool', () => {
  let prisma: PrismaService;
  let mv: PlantEligibleFloatingSeService;
  let pool: SharedPoolService;

  let zoneId: bigint;
  let companyId: bigint;
  let inDistrict: bigint;
  let outDistrict: bigint;
  let inPlant: bigint;
  let outPlant: bigint;
  let floating: string;
  const userIds: string[] = [];
  const deviceIds: bigint[] = [];
  const ticketIds: string[] = [];
  let inTicket: string;
  const NOW = new Date('2026-06-21T06:00:00Z');

  const makeTicket = async (plant: bigint): Promise<string> => {
    const deviceId = BigInt(10_000_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        hasOpenFailureCycle: true,
        latestGpsDatetime: new Date(NOW.getTime() - 120 * 60_000),
        plantId: plant,
        companyId,
        computedAt: NOW,
      },
    });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        assignmentState: 'UNASSIGNED',
        failureCycleId: cycle.cycleId,
        deviceId,
        plantId: plant,
        companyId,
        companyTier: 'GOLD',
        lastStateChangedAt: NOW,
      },
    });
    ticketIds.push(ticket.ticketId);
    return ticket.ticketId;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    mv = new PlantEligibleFloatingSeService(prisma);
    pool = new SharedPoolService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-spf-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-spf-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    // Unique state strings so no other test's state-level territory matches these plants via the MV.
    inDistrict = (await prisma.district.create({ data: { name: 'Din-' + NS, state: 'SpfIn-' + NS } })).districtId;
    outDistrict = (await prisma.district.create({ data: { name: 'Dout-' + NS, state: 'SpfOut-' + NS } })).districtId;
    inPlant = (await prisma.plant.create({ data: { name: 'P-in-' + NS, zoneId, districtId: inDistrict } })).plantId;
    outPlant = (await prisma.plant.create({ data: { name: 'P-out-' + NS, zoneId, districtId: outDistrict } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@spf.test`, zoneId },
    });
    userIds.push(u.userId);
    floating = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: floating, coverageType: 'FLOATING', zoneId, dailyCapacity: 10 } });
    await prisma.engineerTerritoryCoverage.create({ data: { seId: floating, districtId: inDistrict } });
    await mv.refresh();

    inTicket = await makeTicket(inPlant); // inside territory → appears
    await makeTicket(outPlant); // outside territory → excluded
  });

  afterAll(async () => {
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerTerritoryCoverage.deleteMany({ where: { seId: floating } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [inPlant, outPlant] } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.district.deleteMany({ where: { districtId: { in: [inDistrict, outDistrict] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await mv.refresh();
    await prisma.onModuleDestroy();
  });

  it('shows territory-plant tickets and excludes out-of-territory plants for a Floating SE', async () => {
    const result = await pool.getSharedPool(floating);
    expect(result.map((t) => t.ticketId)).toEqual([inTicket]);
    expect(result[0].plantId).toBe(String(inPlant));
  });
});
