import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { SharedPoolService } from '../src/shared-pool/shared-pool.service';

/**
 * Issue 12, slice 3 — the Shared Pool read model (AC#2/#3/#5). getSharedPool(seId) returns OPEN,
 * not-yet-assigned tickets at the SE's covered plants (se_coverage), even with zero formal
 * assignments. Out-of-coverage plants are never returned; FORMALLY_ASSIGNED tickets are committed
 * work and excluded. Coverage scoping is server-side.
 */
const NS = Date.now();

describe('Issue 12 slice 3 — SharedPoolService.getSharedPool (coverage scoping)', () => {
  let prisma: PrismaService;
  let pool: SharedPoolService;

  let zoneId: bigint;
  let companyId: bigint;
  let coveredPlant: bigint;
  let otherPlant: bigint;
  let se: string;
  const userIds: string[] = [];
  const deviceIds: bigint[] = [];
  const ticketIds: string[] = [];
  let openCoveredTicket: string;
  const NOW = new Date('2026-06-21T06:00:00Z');

  const makeTicket = async (
    plant: bigint,
    assignmentState: 'UNASSIGNED' | 'FORMALLY_ASSIGNED',
    status: 'OPEN' | 'CLOSED' = 'OPEN',
  ): Promise<string> => {
    const deviceId = BigInt(9_900_000_000 + (NS % 100_000) * 10 + deviceIds.length);
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
        status,
        assignmentState,
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
    pool = new SharedPoolService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-sp-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-sp-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    coveredPlant = (await prisma.plant.create({ data: { name: 'P-cov-' + NS, zoneId } })).plantId;
    otherPlant = (await prisma.plant.create({ data: { name: 'P-oth-' + NS, zoneId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@sp.test`, zoneId },
    });
    userIds.push(u.userId);
    se = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
    await prisma.seCoverage.create({ data: { seId: se, plantId: coveredPlant, coverageType: 'DEDICATED' } });

    openCoveredTicket = await makeTicket(coveredPlant, 'UNASSIGNED'); // should appear
    await makeTicket(coveredPlant, 'FORMALLY_ASSIGNED'); // committed → excluded
    await makeTicket(coveredPlant, 'UNASSIGNED', 'CLOSED'); // not OPEN → excluded
    await makeTicket(otherPlant, 'UNASSIGNED'); // out of coverage → excluded
  });

  afterAll(async () => {
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seCoverage.deleteMany({ where: { seId: se } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [coveredPlant, otherPlant] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('returns OPEN, UNASSIGNED tickets only for the SE covered plant', async () => {
    const result = await pool.getSharedPool(se);
    expect(result.map((t) => t.ticketId)).toEqual([openCoveredTicket]);
    expect(result[0].plantId).toBe(String(coveredPlant));
    expect(result[0].plantName).toBe('P-cov-' + NS);
  });

  it('never returns out-of-coverage, committed, or closed tickets', async () => {
    const result = await pool.getSharedPool(se);
    const plantIds = new Set(result.map((t) => t.plantId));
    expect(plantIds.has(String(otherPlant))).toBe(false);
    expect(result).toHaveLength(1);
  });
});
