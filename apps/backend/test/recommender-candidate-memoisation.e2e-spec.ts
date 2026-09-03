import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';

/**
 * #330 (forensics AR-11) — the candidate pool is fetched once per plant in a run, not once per ticket.
 *
 * `orderedCandidatesForPlant` is two queries (`se_coverage`, then the floating leg joined live against
 * `engineer_master`) and it ran per **ticket**. Everything else expensive in the loop — Common-Kit
 * completeness, SE availability, plant coordinates, home bases — was already memoised across the run;
 * the pool was the one read left scaling with the ticket list. A 900-ticket zone spent ~1,800 round
 * trips re-answering "who covers this plant?" for plants it had already asked about. Beyond cost, the
 * window this widens is the exposure #305 bounds with its heartbeat: a run that is merely slow can be
 * reaped while healthy.
 *
 * **Why the assertion is a call count and a decision snapshot together.** A memo is only correct if the
 * answer does not change, and "byte-identical decisions" cannot be observed by running the code twice
 * after the fix. So this spec was written and run RED first: the call count failed (6, one per ticket)
 * while every decision assertion below **passed against the unmemoised code**. Those recorded values
 * are therefore the pre-fix output, and the green run is the equivalence.
 */
const NS = Date.now();
const NOW = new Date('2026-08-06T06:00:00Z');

/** Counts what the recommender asks for, and answers exactly as the real service would. */
class CountingCandidateSelection extends CandidateSelectionService {
  readonly calls: string[] = [];

  override async orderedCandidatesForPlant(plantId: bigint) {
    this.calls.push(String(plantId));
    return super.orderedCandidatesForPlant(plantId);
  }
}

describe('#330 — per-plant candidate memoisation', () => {
  let prisma: PrismaService;
  let candidates: CountingCandidateSelection;
  let rec: RecommenderService;

  let zoneId: bigint;
  let companyId: bigint;
  const plantIds: bigint[] = [];
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  /** ticket id → the plant it sits at, so the decision snapshot can be read plant by plant. */
  const plantOfTicket = new Map<string, string>();

  const makeSe = async (plantId: bigint): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: `SE ${tag}`, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@o330.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({
      data: { engineerId: u.userId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 },
    });
    await prisma.seCoverage.create({ data: { seId: u.userId, plantId, coverageType: 'DEDICATED' } });
    return u.userId;
  };

  const makeTicket = async (plantId: bigint): Promise<string> => {
    const deviceId = String(11_100_000_000 + (NS % 100_000) * 100 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        hasOpenFailureCycle: true,
        latestGpsDatetime: NOW,
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
    ticketIds.push(ticket.ticketId);
    plantOfTicket.set(ticket.ticketId, String(plantId));
    return ticket.ticketId;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    candidates = new CountingCandidateSelection(prisma);
    rec = new RecommenderService(prisma, candidates);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-330-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-330-' + NS, companyTier: 'GOLD', companyPriorityRank: 'C' } })
    ).companyId;
    for (let i = 0; i < 2; i++) {
      plantIds.push((await prisma.plant.create({ data: { name: `P${i}-330-` + NS, zoneId } })).plantId);
    }
    // One covering engineer per plant, and three tickets at each plant: the whole point is that six
    // tickets ask about two plants.
    for (const plantId of plantIds) {
      await makeSe(plantId);
      for (let i = 0; i < 3; i++) await makeTicket(plantId);
    }
  });

  afterAll(async () => {
    await prisma.dispatchDecisionTrace.deleteMany({ where: { recommendation: { ticketId: { in: ticketIds } } } });
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seCoverage.deleteMany({ where: { seId: { in: userIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: plantIds } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('AC1 — pool queries scale with plants, not tickets, and the decisions are unchanged', async () => {
    candidates.calls.length = 0;
    const summary = await rec.runForZone(zoneId, { now: NOW });

    // The equivalence half runs FIRST, deliberately: on the red run the count assertion below is the
    // only thing that may fail, so every value here is recorded output of the *unmemoised* code.
    expect(summary.recommended).toBe(6);
    expect(summary.unassignable).toBe(0);

    const recs = await prisma.recommendation.findMany({
      where: { ticketId: { in: ticketIds } },
      orderBy: { processingRank: 'asc' },
      select: { ticketId: true, seId: true, status: true, path: true, processingRank: true },
    });
    expect(recs).toHaveLength(6);
    expect(recs.map((r) => r.status)).toEqual(Array(6).fill('SUGGESTED'));
    expect(recs.map((r) => r.path)).toEqual(Array(6).fill('MORNING_BATCH'));
    // A dense 1..6 processing rank, so the canonical ordering is pinned and not merely present.
    expect(recs.map((r) => r.processingRank)).toEqual([1, 2, 3, 4, 5, 6]);

    // Each ticket went to the engineer who covers ITS plant — the pool answer, per ticket, which is
    // the thing a memo keyed on the wrong scope would get wrong.
    const seOfPlant = new Map<string, string>();
    for (const cov of await prisma.seCoverage.findMany({ where: { seId: { in: userIds } } })) {
      seOfPlant.set(String(cov.plantId), cov.seId);
    }
    for (const r of recs) {
      expect(r.seId).toBe(seOfPlant.get(plantOfTicket.get(r.ticketId)!));
    }

    // Six tickets across two plants. Pre-fix: six calls — one per ticket, re-asking about a plant the
    // run had already resolved. Post-fix: two, one per distinct plant.
    expect(candidates.calls).toHaveLength(2);
    expect(new Set(candidates.calls)).toEqual(new Set(plantIds.map(String)));
  }, 60_000);

  it('the memo is per run — a second run re-reads every plant', async () => {
    // The stale-pool question the issue raises, answered by scope rather than invalidation: within one
    // run the engine already reads a snapshot, so a coverage change mid-run was never going to be seen.
    // Across runs it must be, and nothing may leak between them.
    candidates.calls.length = 0;
    await rec.runForZone(zoneId, { now: NOW });
    expect(candidates.calls).toHaveLength(2);

    candidates.calls.length = 0;
    await rec.runForZone(zoneId, { now: NOW });
    expect(candidates.calls).toHaveLength(2);
  }, 60_000);
});
