import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * #276 — Distribute: several plants × several engineers, projected before anything is written. Three
 * strategies, one shared source of truth for who is eligible and at what tier
 * (`buildCandidateReadiness`/`applyHardFilters`, the same functions the recommender itself calls) —
 * this file exercises the allocation POLICY each strategy layers on top of that one answer.
 */
const NS = Date.now();

describe('#276 — POST /api/schedules/distribute-preview', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantA: bigint;
  let plantB: bigint;
  let plantTie: bigint;
  let seDedicatedA: string;
  let seMultiAB: string;
  let seDedicatedB: string;
  let seTieX: string;
  let seTieY: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  const cycleIds: string[] = [];

  const login = async (email: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'correct-password' })
      .expect(200);
    return res.body.accessToken as string;
  };

  const makeTicket = async (plantId: bigint): Promise<string> => {
    const deviceId = String(12_500_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: { deviceId, isInactive: true, slaBucket: 'CRITICAL', inactivityHours: 40, plantId, companyId, computedAt: new Date() },
    });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: new Date() } });
    cycleIds.push(cycle.cycleId);
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: cycle.cycleId,
        deviceId, plantId, companyId, companyTier: 'GOLD', assignmentState: 'UNASSIGNED', lastStateChangedAt: new Date(),
      },
    });
    ticketIds.push(ticket.ticketId);
    return ticket.ticketId;
  };

  const makeSe = async (coverage: 'DEDICATED' | 'MULTI_PLANT', plants: bigint[], dailyCapacity: number): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@dp.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({ data: { engineerId: u.userId, coverageType: coverage, zoneId, dailyCapacity } });
    for (const p of plants) await prisma.seCoverage.create({ data: { seId: u.userId, plantId: p, coverageType: coverage } });
    return u.userId;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-dp-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-dp-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantA = (await prisma.plant.create({ data: { name: 'P-dp-a-' + NS, zoneId } })).plantId;
    plantB = (await prisma.plant.create({ data: { name: 'P-dp-b-' + NS, zoneId } })).plantId;
    plantTie = (await prisma.plant.create({ data: { name: 'P-dp-tie-' + NS, zoneId } })).plantId;

    // Strict-tier fixture: DEDICATED at each of A/B, capped at 1; MULTI_PLANT covers both, roomy.
    seDedicatedA = await makeSe('DEDICATED', [plantA], 1);
    seMultiAB = await makeSe('MULTI_PLANT', [plantA, plantB], 5);
    seDedicatedB = await makeSe('DEDICATED', [plantB], 1);
    // Tie fixture: two same-tier engineers, both capped at 1, both starting empty — forces headroom's
    // per-ticket placement to visibly alternate rather than pile onto whichever sorts first.
    seTieX = await makeSe('MULTI_PLANT', [plantTie], 1);
    seTieY = await makeSe('MULTI_PLANT', [plantTie], 1);
  });

  afterAll(async () => {
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { cycleId: { in: cycleIds } } });
    await prisma.seCoverage.deleteMany({ where: { plantId: { in: [plantA, plantB, plantTie] } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [plantA, plantB, plantTie] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await app.close();
  });

  const post = (token: string, body: unknown) =>
    request(app.getHttpServer()).post('/api/schedules/distribute-preview').set('Authorization', `Bearer ${token}`).send(body);

  const countAll = async () => ({
    recommendations: await prisma.recommendation.count(),
    traces: await prisma.dispatchDecisionTrace.count(),
    schedules: await prisma.workSchedule.count(),
    batches: await prisma.plantBatchAssignment.count(),
    batchTickets: await prisma.batchAssignmentTicket.count(),
  });

  it('writes nothing: no recommendation, trace, schedule, batch or batch-ticket row', async () => {
    const token = await login('ops.head@fsm.test');
    const t = await makeTicket(plantA);
    const before = await countAll();

    await post(token, { ticketIds: [t], engineerIds: [seDedicatedA], strategy: 'COVERAGE_TIER' }).expect(200);

    const after = await countAll();
    expect(after).toEqual(before);
    const row = await prisma.ticket.findUnique({ where: { ticketId: t } });
    expect(row?.assignmentState).toBe('UNASSIGNED');
  });

  it('single ticket, single eligible candidate: all three strategies agree with each other and with the engine', async () => {
    const token = await login('ops.head@fsm.test');
    const t = await makeTicket(plantA);

    for (const strategy of ['COVERAGE_TIER', 'CAPACITY_HEADROOM', 'PLANT_WHOLE']) {
      const res = await post(token, { ticketIds: [t], engineerIds: [seDedicatedA], strategy }).expect(200);
      expect(res.body.lanes).toEqual([{ seId: seDedicatedA, plants: [{ plantId: String(plantA), ticketIds: [t] }] }]);
      expect(res.body.unplaced).toEqual([]);
    }
  });

  it('running the same projection twice on unchanged data returns the same lanes', async () => {
    const token = await login('ops.head@fsm.test');
    const t1 = await makeTicket(plantA);
    const t2 = await makeTicket(plantB);
    const body = { ticketIds: [t1, t2], engineerIds: [seDedicatedA, seMultiAB, seDedicatedB], strategy: 'COVERAGE_TIER' };

    const first = await post(token, body).expect(200);
    const second = await post(token, body).expect(200);
    expect(second.body.lanes).toEqual(first.body.lanes);
  });

  it('COVERAGE_TIER: strict precedence, never crossing to a lower tier while a higher one is eligible; unplaced reported by name', async () => {
    const token = await login('ops.head@fsm.test');
    const inTierA = await makeTicket(plantA);
    const noCoverage = await makeTicket(plantB);
    const stray = await makeSe('DEDICATED', [], 5); // covers nothing

    const res = await post(token, {
      ticketIds: [inTierA, noCoverage],
      engineerIds: [seDedicatedA, stray],
      strategy: 'COVERAGE_TIER',
    }).expect(200);

    expect(res.body.lanes).toEqual([{ seId: seDedicatedA, plants: [{ plantId: String(plantA), ticketIds: [inTierA] }] }]);
    expect(res.body.unplaced).toEqual([{ ticketId: noCoverage, plantId: String(plantB), reason: 'NO_COVERAGE' }]);
  });

  it('COVERAGE_TIER: an over-capacity DEDICATED candidate is dropped to the next tier, exactly as the engine drops it', async () => {
    const token = await login('ops.head@fsm.test');
    const t1 = await makeTicket(plantA);
    const t2 = await makeTicket(plantA); // seDedicatedA's cap is 1 — this one must fall through

    const res = await post(token, {
      ticketIds: [t1, t2],
      engineerIds: [seDedicatedA, seMultiAB],
      strategy: 'COVERAGE_TIER',
    }).expect(200);

    const laneFor = (seId: string) => res.body.lanes.find((l: { seId: string }) => l.seId === seId);
    const dedicatedTickets = laneFor(seDedicatedA)?.plants.flatMap((p: { ticketIds: string[] }) => p.ticketIds) ?? [];
    const multiTickets = laneFor(seMultiAB)?.plants.flatMap((p: { ticketIds: string[] }) => p.ticketIds) ?? [];
    expect(dedicatedTickets).toHaveLength(1);
    expect(multiTickets).toHaveLength(1);
    expect([...dedicatedTickets, ...multiTickets].sort()).toEqual([t1, t2].sort());
    expect(res.body.unplaced).toEqual([]);
  });

  it('PLANT_WHOLE: never splits one plant across two lanes, even at a tied best tier', async () => {
    const token = await login('ops.head@fsm.test');
    const t1 = await makeTicket(plantTie);
    const t2 = await makeTicket(plantTie);

    const res = await post(token, {
      ticketIds: [t1, t2],
      engineerIds: [seTieX, seTieY],
      strategy: 'PLANT_WHOLE',
    }).expect(200);

    // Exactly one lane touches plantTie, and it carries both tickets.
    const lanesWithPlant = res.body.lanes.filter((l: { plants: { plantId: string }[] }) =>
      l.plants.some((p) => p.plantId === String(plantTie)),
    );
    expect(lanesWithPlant).toHaveLength(1);
    const stop = lanesWithPlant[0].plants.find((p: { plantId: string }) => p.plantId === String(plantTie));
    expect(stop.ticketIds.sort()).toEqual([t1, t2].sort());
    // Both engineers are capped at 1 — two tickets on one of them is over capacity, stated not blocked.
    expect(res.body.overCapacitySeIds).toContain(lanesWithPlant[0].seId);
  });

  it('CAPACITY_HEADROOM: spreads a tied best tier across engineers instead of piling onto one, and may exceed capacity', async () => {
    const token = await login('ops.head@fsm.test');
    const t1 = await makeTicket(plantTie);
    const t2 = await makeTicket(plantTie);

    const res = await post(token, {
      ticketIds: [t1, t2],
      engineerIds: [seTieX, seTieY],
      strategy: 'CAPACITY_HEADROOM',
    }).expect(200);

    const seIdsUsed = new Set(res.body.lanes.map((l: { seId: string }) => l.seId));
    expect(seIdsUsed.size).toBe(2); // split across both, unlike PLANT_WHOLE's single winner
    expect(seIdsUsed).toEqual(new Set([seTieX, seTieY]));
    // Each is capped at 1 and each got exactly one ticket here — 200, no confirm, no block either way.
    expect(res.body.unplaced).toEqual([]);
  });

  it('rejects a missing ticket/engineer selection or an unknown strategy', async () => {
    const token = await login('ops.head@fsm.test');
    await post(token, { ticketIds: [], engineerIds: [seDedicatedA], strategy: 'COVERAGE_TIER' }).expect(400);
    await post(token, { ticketIds: ['x'], engineerIds: [], strategy: 'COVERAGE_TIER' }).expect(400);
    await post(token, { ticketIds: ['x'], engineerIds: [seDedicatedA], strategy: 'MADE_UP' }).expect(400);
  });
});
