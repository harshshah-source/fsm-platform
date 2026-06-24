import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';

/**
 * Issue 21, slice 3 — the Common-Kit Hard Filter wired into the Recommender. A plant whose only SE is
 * Common-Kit-incomplete leaves its tickets unassigned, and each lands on the Component-Blocked Queue
 * with the missing parts. Once the SE is restocked, a re-run assigns the ticket and resolves the block.
 */
const NS = Date.now();
const NOW = new Date('2026-06-23T06:00:00Z');

describe('Issue 21 slice 3 — recommender Common-Kit filter + Component-Blocked Queue', () => {
  let prisma: PrismaService;
  let rec: RecommenderService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let se: string;
  let sim: bigint;
  let kitId: bigint;
  const deviceIds: bigint[] = [];
  const ticketIds: string[] = [];

  const makeTicket = async (): Promise<string> => {
    const deviceId = BigInt(11_900_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId, isInactive: true, slaBucket: 'CRITICAL', eligibleForUptime: true, hasOpenFailureCycle: true,
        latestGpsDatetime: new Date(NOW.getTime() - 30 * 60_000), plantId, companyId, computedAt: NOW,
      },
    });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: cycle.cycleId, deviceId,
        plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: NOW,
      },
    });
    ticketIds.push(ticket.ticketId);
    return ticket.ticketId;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    rec = new RecommenderService(prisma, new CandidateSelectionService(prisma));

    zoneId = (await prisma.zone.create({ data: { name: 'Z-rck-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-rck-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-rck-' + NS, zoneId } })).plantId;
    sim = (await prisma.componentMaster.create({ data: { name: 'SIM-rck-' + NS } })).componentId;
    kitId = (await prisma.commonKitDefinition.create({ data: { componentId: sim, minQty: 1 } })).id;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({ data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@rck.test`, zoneId } });
    se = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
    await prisma.seCoverage.create({ data: { seId: se, plantId, coverageType: 'DEDICATED' } });
    // The SE carries every active kit component at stock (so the global seed kit — cable/SIM/antenna/
    // fuse — doesn't ground them), EXCEPT the test SIM, which is set short to drive the block.
    const activeKit = await prisma.commonKitDefinition.findMany({ where: { active: true } });
    for (const k of activeKit) {
      await prisma.seVanStock.upsert({
        where: { seId_componentId: { seId: se, componentId: k.componentId } },
        create: { seId: se, componentId: k.componentId, qty: 5 },
        update: { qty: 5 },
      });
    }
    await prisma.seVanStock.upsert({
      where: { seId_componentId: { seId: se, componentId: sim } },
      create: { seId: se, componentId: sim, qty: 0 },
      update: { qty: 0 },
    });
  });

  afterAll(async () => {
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.componentBlockedQueue.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seVanStock.deleteMany({ where: { seId: se } });
    await prisma.commonKitDefinition.deleteMany({ where: { id: kitId } });
    await prisma.componentMaster.deleteMany({ where: { componentId: sim } });
    await prisma.seCoverage.deleteMany({ where: { plantId } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: se } });
    await prisma.user.deleteMany({ where: { userId: se } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('drops a Common-Kit-incomplete SE and records the ticket on the Component-Blocked Queue', async () => {
    const ticketId = await makeTicket();
    const summary = await rec.runForZone(zoneId, { now: NOW });
    expect(summary.unassignable).toBe(1);
    expect(summary.recommended).toBe(0);

    const blocked = await prisma.componentBlockedQueue.findFirstOrThrow({ where: { ticketId, resolvedAt: null } });
    expect(blocked.reason).toBe('COMMON_KIT_INCOMPLETE');
    expect(blocked.seId).toBe(se);
    expect(Array.isArray(blocked.missingComponents)).toBe(true);
    expect((blocked.missingComponents as { componentId: string }[]).some((m) => m.componentId === String(sim))).toBe(true);
  });

  it('assigns the ticket and resolves the block once the SE is restocked', async () => {
    // Restock the SIM and clear the prior recommendation so the ticket is unassigned again.
    await prisma.seVanStock.updateMany({ where: { seId: se, componentId: sim }, data: { qty: 5 } });
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.updateMany({ where: { ticketId: { in: ticketIds } }, data: { assignmentState: 'UNASSIGNED' } });

    const summary = await rec.runForZone(zoneId, { now: NOW });
    expect(summary.recommended).toBe(1);

    const active = await prisma.componentBlockedQueue.findMany({ where: { ticketId: { in: ticketIds }, resolvedAt: null } });
    expect(active).toHaveLength(0);
  });
});
