import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/token.service';
import { istDate } from '../src/common/ist-day';
import { PlantEligibleFloatingSeService } from '../src/org/plant-eligible-floating-se.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { OverrideService } from '../src/scheduling/override.service';
import { buildCandidateReadiness } from '../src/recommender/candidate-readiness';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { applyHardFilters } from '../src/recommender/hard-filters';

/**
 * #274 — the Assign Work Console's candidate column: who can cover THIS plant, at which tier, how
 * loaded they already are, and — if the engine would not have picked them — why not.
 *
 * **The whole point is that this is not a second opinion.** `orderedCandidatesForPlant` and
 * `applyHardFilters` are the engine's own answers and have been backend-internal for their entire
 * life; no admin surface could reach either. Every pre-existing picker in this codebase shows a name
 * and nothing else, and `AssignSePanel` shows the engineer's *global* `engineer_master.coverage_type`
 * — which for a MULTI_PLANT engineer says nothing about whether they cover the plants being assigned.
 *
 * So the failure mode this file exists to catch is quiet, not loud: a re-implemented filter or a
 * second capacity count that *looks* right on screen and disagrees with the engine under load. Every
 * assertion below is therefore an **equivalence** against an existing seam rather than a hardcoded
 * expectation — the order against the selection service, the verdict against the shared filter, the
 * committed figure against #269's own endpoint.
 */
const NS = Date.now();

interface CandidateRow {
  seId: string;
  name: string | null;
  coverageType: string;
  tierRank: number;
  verdict: string;
  dropReason: string | null;
  committed: number;
  dailyCapacity: number;
  availabilityStatus: string;
  kitComplete: boolean;
  missingKit: string[];
}

interface CandidatesView {
  date: string;
  plants: { plantId: string; plantName: string; zoneId: string; candidates: CandidateRow[] }[];
}

describe('#274 — assign console candidates', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: TokenService;
  let selection: CandidateSelectionService;
  let override: OverrideService;
  let mv: PlantEligibleFloatingSeService;

  let zoneId: bigint;
  let otherZoneId: bigint;
  let districtId: bigint;
  let plantId: bigint;
  let otherZonePlantId: bigint;

  let dedicated: string;
  let multi: string;
  let floating: string;

  let zmToken: string;
  let ohToken: string;
  let companyId: bigint;

  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  const scheduleIds: string[] = [];

  /** The IST operating day both endpoints compute their committed figure for. */
  const TODAY = istDate(new Date());

  const makeSe = async (
    coverageType: 'DEDICATED' | 'MULTI_PLANT' | 'FLOATING',
    dailyCapacity = 6,
  ): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@cand274.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({
      data: { engineerId: u.userId, coverageType, zoneId, dailyCapacity },
    });
    return u.userId;
  };

  /** One OPEN troubleshoot ticket at the shared plant, with the device state behind it. */
  const makeTicket = async (): Promise<string> => {
    const deviceId = String(12_740_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        hasOpenFailureCycle: true,
        latestGpsDatetime: new Date(Date.now() - 30 * 3_600_000),
        plantId,
        companyId,
        computedAt: new Date(),
      },
    });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: new Date() } });
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        failureCycleId: cycle.cycleId,
        deviceId,
        plantId,
        companyId,
        companyTier: 'GOLD',
        lastStateChangedAt: new Date(),
      },
    });
    ticketIds.push(ticket.ticketId);
    return ticket.ticketId;
  };

  /**
   * Put `count` live day-plan stops on `se` for today — schedule → batch → live
   * `batch_assignment_tickets`, the exact shape a dispatch leaves behind, which is what
   * `committedDayLoad` counts.
   */
  const loadSe = async (se: string, count: number): Promise<void> => {
    const schedule = await prisma.workSchedule.create({
      data: { seId: se, zoneId, dateFrom: TODAY, dateTo: TODAY, status: 'ACTIVE', dispatchedAt: new Date() },
    });
    scheduleIds.push(schedule.scheduleId);
    const batch = await prisma.plantBatchAssignment.create({
      data: { scheduleId: schedule.scheduleId, plantId, seId: se, status: 'AUTO_ASSIGNED', stopSequence: 1 },
    });
    for (let i = 0; i < count; i++) {
      const ticketId = await makeTicket();
      await prisma.ticket.update({ where: { ticketId }, data: { assignmentState: 'FORMALLY_ASSIGNED' } });
      await prisma.batchAssignmentTicket.create({ data: { batchId: batch.batchId, ticketId, sortOrder: i + 1 } });
    }
  };

  const fetchEngineers = (token: string) =>
    request(app.getHttpServer()).get('/api/schedules/engineers').set('Authorization', `Bearer ${token}`);

  const fetchCandidates = (token: string, plantIds: bigint[], headers: Record<string, string> = {}) => {
    const req = request(app.getHttpServer())
      .get(`/api/schedules/candidates?plantIds=${plantIds.join(',')}`)
      .set('Authorization', `Bearer ${token}`);
    for (const [k, v] of Object.entries(headers)) req.set(k, v);
    return req;
  };

  const plantRow = (body: CandidatesView, id: bigint) => body.plants.find((p) => p.plantId === String(id));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);
    selection = app.get(CandidateSelectionService);
    override = app.get(OverrideService);
    mv = new PlantEligibleFloatingSeService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-c274-' + NS } })).zoneId;
    otherZoneId = (await prisma.zone.create({ data: { name: 'Z-c274-other-' + NS } })).zoneId;
    // A unique state, so no other fixture's state-level floating territory matches this plant via the MV.
    districtId = (await prisma.district.create({ data: { name: 'D-c274-' + NS, state: 'C274State-' + NS } })).districtId;
    plantId = (await prisma.plant.create({ data: { name: 'P-c274-' + NS, zoneId, districtId } })).plantId;
    otherZonePlantId = (
      await prisma.plant.create({ data: { name: 'P-c274-other-' + NS, zoneId: otherZoneId } })
    ).plantId;

    companyId = (
      await prisma.company.create({ data: { name: 'Co-c274-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;

    dedicated = await makeSe('DEDICATED');
    multi = await makeSe('MULTI_PLANT');
    floating = await makeSe('FLOATING');

    await prisma.seCoverage.create({ data: { seId: dedicated, plantId, coverageType: 'DEDICATED' } });
    await prisma.seCoverage.create({ data: { seId: multi, plantId, coverageType: 'MULTI_PLANT' } });
    await prisma.engineerTerritoryCoverage.create({ data: { seId: floating, districtId } });
    await mv.refresh();

    const zmTag = randomUUID().slice(0, 8);
    const zmUser = await prisma.user.create({
      data: { name: 'ZM ' + zmTag, role: 'ZONAL_MANAGER', phone: 'ph-' + zmTag, email: `${zmTag}@cand274.test`, zoneId },
    });
    userIds.push(zmUser.userId);
    zmToken = tokens.signAccessToken({ user_id: zmUser.userId, role: 'ZONAL_MANAGER', zone_id: Number(zoneId) });

    const ohTag = randomUUID().slice(0, 8);
    const ohUser = await prisma.user.create({
      data: { name: 'OH ' + ohTag, role: 'OPERATIONS_HEAD', phone: 'ph-' + ohTag, email: `${ohTag}@cand274.test` },
    });
    userIds.push(ohUser.userId);
    ohToken = tokens.signAccessToken({ user_id: ohUser.userId, role: 'OPERATIONS_HEAD', zone_id: null });
  });

  afterAll(async () => {
    const batches = await prisma.plantBatchAssignment.findMany({
      where: { scheduleId: { in: scheduleIds } },
      select: { batchId: true },
    });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { scheduleId: { in: scheduleIds } } });
    await prisma.workSchedule.deleteMany({ where: { scheduleId: { in: scheduleIds } } });
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await prisma.seAvailability.deleteMany({ where: { seId: { in: userIds } } });
    await prisma.engineerTerritoryCoverage.deleteMany({ where: { seId: { in: userIds } } });
    await prisma.seCoverage.deleteMany({ where: { plantId: { in: [plantId, otherZonePlantId] } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [plantId, otherZonePlantId] } } });
    await prisma.district.deleteMany({ where: { districtId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: [zoneId, otherZoneId] } } });
    await mv.refresh();
    await app.close();
  });

  /**
   * Slice B1 — **AC-1.** The column's order is the engine's order, byte for byte.
   *
   * Asserted by calling both in one test rather than by hardcoding a sequence: a literal would pin
   * what this fixture happens to produce, while the requirement is that the two *agree*. The HTTP
   * layer is a real opportunity to disagree — it could sort by name for the operator's convenience,
   * group by tier and lose the within-tier `se_id` ordering, or drop the tail — and each of those
   * would render a ranking the engine does not use, which is the false model #266 was sequenced ahead
   * of this issue to prevent.
   */
  it('lists candidates in orderedCandidatesForPlant order, unchanged', async () => {
    const res = await fetchCandidates(zmToken, [plantId]);
    expect(res.status).toBe(200);

    const engine = await selection.orderedCandidatesForPlant(plantId);
    const row = plantRow(res.body as CandidatesView, plantId);
    expect(row).toBeDefined();

    expect(row!.candidates.map((c) => c.seId)).toEqual(engine.map((c) => c.seId));
    expect(row!.candidates.map((c) => c.coverageType)).toEqual(engine.map((c) => c.coverageType));
    // The fixture is only meaningful if all three tiers are actually populated — a one-tier plant
    // would let a tier-losing implementation pass.
    expect(engine.map((c) => c.coverageType)).toEqual(['DEDICATED', 'MULTI_PLANT', 'FLOATING']);
  });
  /**
   * Slice B2 — **AC-2 and AC-3.** A dropped candidate is present with its reason, and the row cannot
   * contradict itself.
   *
   * AC-3 first, because it is the operator's actual question. `applyHardFilters` returns
   * `{passed, dropped}` and the engine persists only the drop **counts** to the trace — the rows
   * themselves have never been stored or surfaced anywhere. An empty list is the least useful possible
   * answer to "why not them", so the endpoint returns the dropped candidates rather than filtering
   * them out.
   *
   * AC-2 is asserted as **self-consistency of the published row**, which is stronger than re-running
   * the engine beside it and comparing. The endpoint publishes each candidate's readiness facts —
   * availability, load against capacity, kit — *and* a verdict. Feeding those published facts back
   * through the engine's own `buildCandidateReadiness` + `applyHardFilters` and requiring the same
   * partition means a row can never say "ON_LEAVE" and "PASSED" at once, nor "12 / 8" and "PASSED",
   * whatever the implementation does internally. A second copy of the filter passes an
   * output-comparison test as long as the copy is currently correct; it cannot pass this one while
   * disagreeing with the facts it prints beside the verdict.
   */
  it('returns dropped candidates with their reason, and no row contradicts its own facts', async () => {
    // The MULTI_PLANT engineer goes on leave: an open-ended window starting in the past, which is the
    // shape `currentStatusMany` reads. Chosen over capacity or kit because it is the drop the design's
    // own candidate column illustrates, and because it is invisible on every existing picker.
    await prisma.seAvailability.create({
      data: {
        seId: multi,
        status: 'ON_LEAVE',
        windowStart: new Date(Date.now() - 3_600_000),
        windowEnd: null,
        setByRole: 'ZONAL_MANAGER',
      },
    });

    const res = await fetchCandidates(zmToken, [plantId]);
    expect(res.status).toBe(200);
    const row = plantRow(res.body as CandidatesView, plantId)!;

    // AC-3 — still listed, in place, with the reason.
    const dropped = row.candidates.find((c) => c.seId === multi);
    expect(dropped).toBeDefined();
    expect(dropped!.verdict).toBe('DROPPED');
    expect(dropped!.dropReason).toBe('SE_UNAVAILABLE');
    expect(dropped!.availabilityStatus).toBe('ON_LEAVE');
    // ...and the other two are unaffected, so the drop is a per-candidate answer and not a mode.
    expect(row.candidates.filter((c) => c.verdict === 'PASSED').map((c) => c.seId).sort()).toEqual(
      [dedicated, floating].sort(),
    );

    // AC-2 — the engine's own rule, run over the facts the endpoint just printed.
    const readiness = row.candidates.map((c) =>
      buildCandidateReadiness({
        seId: c.seId,
        coverageType: c.coverageType as 'DEDICATED' | 'MULTI_PLANT' | 'FLOATING',
        availabilityStatus: c.availabilityStatus as 'AVAILABLE',
        committed: c.committed,
        capacity: c.dailyCapacity === null ? undefined : { dailyCapacity: c.dailyCapacity, isActive: true },
        commonKitComplete: c.kitComplete,
      }),
    );
    const filtered = applyHardFilters(readiness);
    expect(filtered.passed.map((c) => c.seId)).toEqual(
      row.candidates.filter((c) => c.verdict === 'PASSED').map((c) => c.seId),
    );
    expect(filtered.dropped.map((d) => [d.candidate.seId, d.reason])).toEqual(
      row.candidates.filter((c) => c.verdict === 'DROPPED').map((c) => [c.seId, c.dropReason]),
    );
  });

  /**
   * Slice B3 — **AC-4.** `committed` is #269's figure, not a lookalike.
   *
   * #269 found **three** live definitions of "how much work is this engineer carrying today" and two
   * of them were wrong: one counted a multi-day plan's whole range against today, another counted one
   * schedule rather than one day. Nothing rendered any of them beside `daily_capacity`, so the
   * disagreement was invisible. It collapsed them into `scheduling/committed-day-load.ts`, and #274's
   * dependency list calls building a fourth here "forking the definition".
   *
   * So this asserts through **both public seams** rather than trusting the shared import: the number
   * the candidate column publishes must equal the number `/schedules/engineers` publishes — the read
   * every other picker in the app already renders — for the same engineer on the same day. An import
   * can be quietly replaced by an inline count; two endpoints agreeing on a non-zero figure cannot.
   */
  it('publishes the same committed figure as #269 for the same engineer and day', async () => {
    await loadSe(dedicated, 3);

    const [cand, eng] = await Promise.all([fetchCandidates(zmToken, [plantId]), fetchEngineers(zmToken)]);
    expect(cand.status).toBe(200);
    expect(eng.status).toBe(200);

    const fromColumn = plantRow(cand.body as CandidatesView, plantId)!.candidates.find((c) => c.seId === dedicated)!;
    const fromPicker = (eng.body as { engineerId: string; committed: number; dailyCapacity: number }[]).find(
      (e) => e.engineerId === dedicated,
    )!;

    // A vacuous 0 = 0 would prove nothing: both could be counting nothing at all.
    expect(fromPicker.committed).toBe(3);
    expect(fromColumn.committed).toBe(fromPicker.committed);
    expect(fromColumn.dailyCapacity).toBe(fromPicker.dailyCapacity);
  });

  /**
   * Slice B4 — **AC-8.** A ZM sees candidates only for plants in their own zone.
   *
   * Both halves matter. The ZM asking for a plant in a neighbouring zone gets **no row for it** — not
   * an empty candidate list, which would read as "nobody covers that site" and is a different and
   * worse claim — while the same request from an Operations Head answers for both. And the mixed
   * request is the one that catches a clamp applied to the *request* rather than to each *plant*: the
   * ZM's own plant must still come back beside the one that is withheld.
   */
  it('clamps a ZM to their own zone, per plant, while OH sees both', async () => {
    const zm = await fetchCandidates(zmToken, [plantId, otherZonePlantId]);
    expect(zm.status).toBe(200);
    expect((zm.body as CandidatesView).plants.map((p) => p.plantId)).toEqual([String(plantId)]);

    const oh = await fetchCandidates(ohToken, [plantId, otherZonePlantId]);
    expect(oh.status).toBe(200);
    expect((oh.body as CandidatesView).plants.map((p) => p.plantId).sort()).toEqual(
      [String(plantId), String(otherZonePlantId)].sort(),
    );
  });

  /**
   * Slice B5 — **AC-5, the Q2 regression pin.** Over capacity is a marking, never a gate.
   *
   * #258 **Q2** rules manual overload an administrative right: capacity is a *scheduler* constraint,
   * not an authorization limit. So the console has to say two true things at once about the same
   * engineer — the engine would not pick them, **and** you may. This test pins both ends of that in
   * one place: the read reports `DROPPED · OVER_CAPACITY` with the load that justifies it, and the
   * write the console commits through then accepts them with no confirm step, no extra reason and no
   * refusal.
   *
   * The verdict is deliberately **not** softened to `PASSED` for this one filter. The design mock
   * tags its over-capacity candidate `PASSED`, but its own Q2 note calls capacity "a scheduler
   * constraint" — which is exactly a candidate the scheduler drops — and AC-2 requires the verdict to
   * be `applyHardFilters`' verdict rather than a second opinion. Selectability is what makes overload
   * an administrative right; faking the engine's answer would make the column lie about dispatch in
   * order to say something the adjacent marking already says truthfully.
   */
  it('marks an over-capacity engineer as dropped and still lets the console assign to them', async () => {
    // Load the FLOATING SE to exactly their capacity — the `>=` boundary, which is where #269 and the
    // recommender agree and where a `>` implementation would wrongly report room.
    const master = await prisma.engineerMaster.findUniqueOrThrow({ where: { engineerId: floating } });
    await loadSe(floating, master.dailyCapacity);

    const res = await fetchCandidates(zmToken, [plantId]);
    const row = plantRow(res.body as CandidatesView, plantId)!.candidates.find((c) => c.seId === floating)!;
    expect(row.verdict).toBe('DROPPED');
    expect(row.dropReason).toBe('OVER_CAPACITY');
    expect(row.committed).toBe(master.dailyCapacity);
    expect(row.dailyCapacity).toBe(master.dailyCapacity);

    // ...and the write goes through anyway. `assignPlants` is what the console's commit calls.
    await makeTicket();
    const summary = await override.assignPlants(
      [String(plantId)],
      floating,
      { role: 'ZONAL_MANAGER', zoneId: Number(zoneId) },
      { userId: userIds[userIds.length - 2], role: 'ZONAL_MANAGER', actedAsRole: null },
    );
    expect('result' in summary).toBe(false);
    expect((summary as { assigned: number }).assigned).toBeGreaterThan(0);
  });

});
