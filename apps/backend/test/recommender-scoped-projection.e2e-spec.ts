import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';

/**
 * #276 — the `ticketIds`/`engineerIds` scope `RecommenderService.runForZone` gained so Distribute's
 * projection can reuse the real engine rather than fork it. Both extend #250's existing dry-run seam;
 * this file pins that the scope narrows the universe the SAME selection code runs over, and writes
 * nothing, exactly as #250's own suite pins for the unscoped case.
 */
const NS = Date.now();
const NOW = new Date('2026-06-21T06:00:00Z');

describe('#276 — runForZone ticketIds/engineerIds scope', () => {
  let prisma: PrismaService;
  let rec: RecommenderService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantA: bigint;
  let plantB: bigint;
  let seDedicatedA: string;
  let seMultiAB: string;
  let seDedicatedB: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  let ticketAtA: string;
  let ticketAtB: string;

  const countAll = async () => ({
    recommendations: await prisma.recommendation.count(),
    traces: await prisma.dispatchDecisionTrace.count(),
    schedules: await prisma.workSchedule.count(),
    batches: await prisma.plantBatchAssignment.count(),
    batchTickets: await prisma.batchAssignmentTicket.count(),
  });

  const makeTicket = async (plantId: bigint): Promise<string> => {
    const deviceId = String(12_400_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId, isInactive: true, slaBucket: 'CRITICAL', eligibleForUptime: true, hasOpenFailureCycle: true,
        inactivityHours: 48, latestGpsDatetime: new Date(NOW.getTime() - 48 * 3_600_000), plantId, companyId, computedAt: NOW,
      },
    });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
    const ticket = await prisma.ticket.create({
      data: { workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: cycle.cycleId, deviceId, plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: NOW },
    });
    ticketIds.push(ticket.ticketId);
    return ticket.ticketId;
  };

  const makeSe = async (coverage: 'DEDICATED' | 'MULTI_PLANT', plants: bigint[]): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@rsp.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({ data: { engineerId: u.userId, coverageType: coverage, zoneId, dailyCapacity: 10 } });
    for (const p of plants) await prisma.seCoverage.create({ data: { seId: u.userId, plantId: p, coverageType: coverage } });
    return u.userId;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    rec = new RecommenderService(prisma, new CandidateSelectionService(prisma));

    zoneId = (await prisma.zone.create({ data: { name: 'Z-rsp-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-rsp-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantA = (await prisma.plant.create({ data: { name: 'P-rsp-a-' + NS, zoneId } })).plantId;
    plantB = (await prisma.plant.create({ data: { name: 'P-rsp-b-' + NS, zoneId } })).plantId;

    seDedicatedA = await makeSe('DEDICATED', [plantA]);
    seMultiAB = await makeSe('MULTI_PLANT', [plantA, plantB]);
    seDedicatedB = await makeSe('DEDICATED', [plantB]);

    ticketAtA = await makeTicket(plantA);
    ticketAtB = await makeTicket(plantB);
  });

  afterAll(async () => {
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seCoverage.deleteMany({ where: { plantId: { in: [plantA, plantB] } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [plantA, plantB] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('unscoped: strict precedence picks the DEDICATED engineer at each plant', async () => {
    const summary = await rec.runForZone(zoneId, { now: NOW, dryRun: true });
    const bySe = new Map(summary.projection!.decisions.map((d) => [d.ticketId, d.seId]));
    expect(bySe.get(ticketAtA)).toBe(seDedicatedA);
    expect(bySe.get(ticketAtB)).toBe(seDedicatedB);
  });

  it('engineerIds scope: excluding both DEDICATED engineers falls through to the MULTI_PLANT one, at both plants', async () => {
    const before = await countAll();
    const summary = await rec.runForZone(zoneId, { now: NOW, dryRun: true, engineerIds: [seMultiAB] });
    const after = await countAll();
    expect(after).toEqual(before); // still a dry run — no mutation just because the scope narrowed

    const bySe = new Map(summary.projection!.decisions.map((d) => [d.ticketId, d.seId]));
    expect(bySe.get(ticketAtA)).toBe(seMultiAB);
    expect(bySe.get(ticketAtB)).toBe(seMultiAB);
    expect(summary.projection!.plan).toEqual([
      { seId: seMultiAB, plants: expect.arrayContaining([{ plantId: String(plantA), ticketIds: [ticketAtA] }, { plantId: String(plantB), ticketIds: [ticketAtB] }]) },
    ]);
  });

  it('engineerIds scope: an empty selected pool reports NO_COVERAGE, not a silent drop', async () => {
    const other = await makeSe('DEDICATED', []); // covers nothing
    const summary = await rec.runForZone(zoneId, { now: NOW, dryRun: true, engineerIds: [other] });
    const decisions = summary.projection!.decisions;
    expect(decisions.every((d) => d.seId === null)).toBe(true);
    expect(decisions.every((d) => d.poolEmptyReason === 'NO_COVERAGE')).toBe(true);
    expect(summary.projection!.plan).toEqual([]);
  });

  it('ticketIds scope: only the named tickets are considered, even though others are dispatchable', async () => {
    const summary = await rec.runForZone(zoneId, { now: NOW, dryRun: true, ticketIds: [ticketAtA] });
    expect(summary.projection!.decisions).toHaveLength(1);
    expect(summary.projection!.decisions[0].ticketId).toBe(ticketAtA);
  });

  it('running the same scoped projection twice on unchanged data returns the same lanes (determinism)', async () => {
    const a = await rec.runForZone(zoneId, { now: NOW, dryRun: true, ticketIds: [ticketAtA, ticketAtB], engineerIds: [seMultiAB] });
    const b = await rec.runForZone(zoneId, { now: NOW, dryRun: true, ticketIds: [ticketAtA, ticketAtB], engineerIds: [seMultiAB] });
    expect(a.projection!.plan).toEqual(b.projection!.plan);
    expect(a.projection!.decisions.map((d) => ({ ticketId: d.ticketId, seId: d.seId }))).toEqual(
      b.projection!.decisions.map((d) => ({ ticketId: d.ticketId, seId: d.seId })),
    );
  });
});
