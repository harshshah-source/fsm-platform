import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { SeAvailabilityService } from '../src/engineers/se-availability.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';

/**
 * Issue 25 slice 4 (AC#4) — an SE with an active non-AVAILABLE availability window is excluded from
 * Recommender candidate scoring for that window. Closes the availability seam in
 * `recommender.service` readiness (previously `available: isActive` only). With the sole covering SE
 * on leave, the ticket persists UNASSIGNABLE (NO_ELIGIBLE_SE) — never silently dropped.
 */
const NS = Date.now();
const NOW = new Date('2026-06-21T06:00:00Z');

describe('Issue 25 slice 4 — Recommender excludes unavailable SEs', () => {
  let prisma: PrismaService;
  let rec: RecommenderService;
  let availability: SeAvailabilityService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let dedicated: string;
  const userIds: string[] = [];
  let deviceId: bigint;
  let ticketId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    rec = new RecommenderService(prisma, new CandidateSelectionService(prisma));
    availability = new SeAvailabilityService(prisma);

    for (const [component, weight] of [
      ['company_priority_rank', 0.4],
      ['dispatch_urgency', 0.3],
      ['repeat_failure_penalty', 0.2],
      ['distance', 0.1],
    ] as const) {
      await prisma.priorityRuleConfig.upsert({
        where: { weightSetRef_component: { weightSetRef: 'v1', component } },
        create: { weightSetRef: 'v1', component, weight, active: true },
        update: { weight, active: true },
      });
    }

    zoneId = (await prisma.zone.create({ data: { name: 'Z-recav-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-recav-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-recav-' + NS, zoneId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'rav-' + tag, email: `${tag}@rav.test`, zoneId },
    });
    dedicated = u.userId;
    userIds.push(dedicated);
    await prisma.engineerMaster.create({
      data: { engineerId: dedicated, coverageType: 'DEDICATED', zoneId, dailyCapacity: 5 },
    });
    await prisma.seCoverage.create({ data: { seId: dedicated, plantId, coverageType: 'DEDICATED' } });

    deviceId = BigInt(9_400_000_000 + (NS % 100_000));
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        hasOpenFailureCycle: true,
        latestGpsDatetime: new Date(NOW.getTime() - 120 * 60_000),
        plantId,
        companyId,
        computedAt: NOW,
      },
    });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        failureCycleId: cycle.cycleId,
        deviceId,
        plantId,
        companyId,
        companyTier: 'GOLD',
        lastStateChangedAt: NOW,
      },
    });
    ticketId = ticket.ticketId;
  });

  afterAll(async () => {
    await prisma.recommendation.deleteMany({ where: { ticketId } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId } });
    await prisma.ticket.deleteMany({ where: { ticketId } });
    await prisma.failureCycle.deleteMany({ where: { deviceId } });
    await prisma.seAvailability.deleteMany({ where: { seId: { in: userIds } } });
    await prisma.seCoverage.deleteMany({ where: { plantId } });
    await prisma.deviceState.deleteMany({ where: { deviceId } });
    await prisma.device.deleteMany({ where: { deviceId } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  const recFor = () =>
    prisma.recommendation.findFirstOrThrow({ where: { ticketId }, orderBy: { recommendationId: 'desc' } });

  it('recommends the only covering SE while AVAILABLE', async () => {
    await rec.runForZone(zoneId, { now: NOW });
    const r = await recFor();
    expect(r.status).toBe('SUGGESTED');
    expect(r.seId).toBe(dedicated);
  });

  it('excludes the SE while an ON_LEAVE window is active → ticket UNASSIGNABLE', async () => {
    const out = await availability.setAvailability(
      {
        seId: dedicated,
        status: 'ON_LEAVE',
        windowStart: new Date('2026-06-21T00:00:00Z'),
        windowEnd: new Date('2026-06-22T00:00:00Z'),
        reason: 'leave',
      },
      { userId: dedicated, role: 'SERVICE_ENGINEER', zoneId: Number(zoneId) },
    );
    expect(out.result).toBe('OK');

    await rec.runForZone(zoneId, { now: NOW });
    const r = await recFor();
    expect(r.status).toBe('UNASSIGNABLE');
    expect(r.seId).toBeNull();
    expect((r.scoreBreakdown as Record<string, unknown>).reason).toBe('NO_ELIGIBLE_SE');
  });
});
