import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';

/**
 * #267 — the recommender's `distance` score component gets a real feed: SE home/base → route-chain
 * distance to the candidate ticket's plant, via a raw PostGIS prefetch of plant geometry (once per
 * zone-run) and admin-entered `engineer_master.home_lat/home_lng`.
 */
const NS = Date.now();
const NOW = new Date('2026-08-24T06:00:00Z');

describe('#267 — SE home/base + route-chain distance', () => {
  let prisma: PrismaService;
  let rec: RecommenderService;

  let zoneId: bigint;
  let companyId: bigint;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  const plantIds: bigint[] = [];

  const setWeights = async () => {
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
  };

  const makePlant = async (lat?: number, lng?: number): Promise<bigint> => {
    const plant = await prisma.plant.create({ data: { name: 'P-dist-' + NS + '-' + plantIds.length, zoneId } });
    plantIds.push(plant.plantId);
    if (lat !== undefined && lng !== undefined) {
      await prisma.$executeRawUnsafe(
        `UPDATE plants SET location = ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326) WHERE plant_id = ${plant.plantId}`,
      );
    }
    return plant.plantId;
  };

  const makeSe = async (plantId: bigint, home?: { lat: number; lng: number }): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ds-' + tag, email: `${tag}@ds.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({
      data: {
        engineerId: u.userId,
        coverageType: 'DEDICATED',
        zoneId,
        dailyCapacity: 10,
        homeLat: home?.lat ?? null,
        homeLng: home?.lng ?? null,
      },
    });
    await prisma.seCoverage.create({ data: { seId: u.userId, plantId, coverageType: 'DEDICATED' } });
    return u.userId;
  };

  const makeTicket = async (plantId: bigint, ageMinutes: number): Promise<string> => {
    const deviceId = String(9_600_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        hasOpenFailureCycle: true,
        latestGpsDatetime: new Date(NOW.getTime() - ageMinutes * 60_000),
        plantId,
        companyId,
        computedAt: NOW,
      },
    });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
    const t = await prisma.ticket.create({
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
    ticketIds.push(t.ticketId);
    return t.ticketId;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    rec = new RecommenderService(prisma, new CandidateSelectionService(prisma));
    await setWeights();
    zoneId = (await prisma.zone.create({ data: { name: 'Z-dist-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-dist-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
  });

  afterAll(async () => {
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seCoverage.deleteMany({ where: { seId: { in: userIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: plantIds } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  const recFor = (ticketId: string) =>
    prisma.recommendation.findFirstOrThrow({ where: { ticketId }, orderBy: { recommendationId: 'desc' } });

  it('AC — same tier, equal other factors: the nearer SE (by home base) wins the first assignment', async () => {
    // Plant in Delhi. seNear's home base is a few km away; seFar's is Mumbai (~1150 km).
    const plantId = await makePlant(28.6139, 77.209);
    const seNear = await makeSe(plantId, { lat: 28.7, lng: 77.3 });
    const seFar = await makeSe(plantId, { lat: 19.076, lng: 72.8777 });
    const ticketId = await makeTicket(plantId, 60);

    await rec.runForZone(zoneId, { now: NOW });
    const r = await recFor(ticketId);
    expect(r.seId).toBe(seNear);
    expect(r.seId).not.toBe(seFar);

    const breakdown = r.scoreBreakdown as Record<string, unknown>;
    expect(typeof breakdown.distanceKm).toBe('number');
    expect(breakdown.distanceKm as number).toBeLessThan(50);
  });

  it('AC — chain advancement: after an SE wins a stop at plant P, a later ticket AT P prefers them via distance', async () => {
    // Neither candidate has a home base and neither has a prior stop, so ticket 1 is a genuine tie
    // (both NOT_AVAILABLE, 0 contribution) decided by precedence (se_id ascending). Whichever SE wins
    // it should then be preferred for ticket 2 at the SAME plant, purely because their `currentPos`
    // advanced there — proving the win-then-advance mechanism, not proximity they started with.
    const plantId = await makePlant(28.6139, 77.209);
    const seA = await makeSe(plantId);
    const seB = await makeSe(plantId);
    // Ticket 1 is older (processed first by canonical order: Oldest Inactive asc).
    const ticket1 = await makeTicket(plantId, 120);
    const ticket2 = await makeTicket(plantId, 60);

    await rec.runForZone(zoneId, { now: NOW });
    const r1 = await recFor(ticket1);
    const r2 = await recFor(ticket2);
    expect([seA, seB]).toContain(r1.seId);
    // The second ticket at the same plant goes to whoever won the first — their distance is now 0,
    // strictly beating the other candidate's still-NOT_AVAILABLE distance.
    expect(r2.seId).toBe(r1.seId);
    const breakdown2 = r2.scoreBreakdown as Record<string, unknown>;
    expect(breakdown2.distanceKm).toBe(0);
  });

  it('AC — a plant with NULL location yields NOT_AVAILABLE, never a fabricated (0,0) distance', async () => {
    const plantId = await makePlant(); // no geometry
    const se = await makeSe(plantId, { lat: 28.6139, lng: 77.209 });
    const ticketId = await makeTicket(plantId, 60);

    await rec.runForZone(zoneId, { now: NOW });
    const r = await recFor(ticketId);
    expect(r.seId).toBe(se); // still assigned — NOT_AVAILABLE never drops a candidate
    const breakdown = r.scoreBreakdown as Record<string, unknown>;
    expect(breakdown.distanceKm).toBe('NOT_AVAILABLE');
  });

  it('AC — an SE with no home base and no prior stop: distance NOT_AVAILABLE, 0 contribution, never dropped', async () => {
    const plantId = await makePlant(28.6139, 77.209);
    const se = await makeSe(plantId); // no home base
    const ticketId = await makeTicket(plantId, 60);

    await rec.runForZone(zoneId, { now: NOW });
    const r = await recFor(ticketId);
    expect(r.seId).toBe(se);
    const breakdown = r.scoreBreakdown as Record<string, unknown>;
    expect(breakdown.distanceKm).toBe('NOT_AVAILABLE');
    expect(breakdown.distanceScore).toBe(0);
  });

  it('AC — plant coordinates are fetched exactly once per zone-run, not per ticket', async () => {
    const plantId = await makePlant(28.6139, 77.209);
    await makeSe(plantId, { lat: 28.7, lng: 77.3 });
    await makeTicket(plantId, 180);
    await makeTicket(plantId, 120);
    await makeTicket(plantId, 60);

    const spy = vi.spyOn(prisma, '$queryRaw');
    await rec.runForZone(zoneId, { now: NOW });
    const geometryCalls = spy.mock.calls.filter((args) => {
      const sql = (args[0] as { sql?: string })?.sql ?? String(args[0]);
      return sql.includes('ST_Y(location)');
    });
    expect(geometryCalls).toHaveLength(1);
    spy.mockRestore();
  });
});
