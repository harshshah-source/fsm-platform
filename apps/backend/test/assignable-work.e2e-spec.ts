import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { TokenService } from '../src/auth/token.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { OverrideService } from '../src/scheduling/override.service';

/**
 * #273 — the Assign Work Console's work pool: how much unassigned work exists, where it is, and what
 * is deliberately held back. Decision #272 **R3**.
 *
 * **The number on screen must be the number the button moves.** Two definitions of "unassigned work at
 * a plant" were live before this: `assignPlants` writes `OPEN + UNASSIGNED + not-deferred-today`
 * (`override.service.ts`), while `plantDeviceStats` counts by `assignment_state` alone
 * (`dispatch-transparency-query.service.ts`) — no open-status clause, no deferral clause. The console
 * was going to be fed from a read and committed through a write, so building it on the second while
 * committing through the first would have shown a count the adjacent button could not deliver: every
 * `VERIFICATION_PENDING` ticket and every deferred one counted as work waiting to be handed out.
 *
 * `src/ticketing/assignable-work.ts` is now the one predicate, and the test that matters is not that
 * both call sites import it — it is that the **read predicts the write**: count the plant, assign the
 * plant, and the two numbers agree with nothing changing in between.
 */
const NS = Date.now();

describe('#273 — assignable work pool', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: TokenService;
  let override: OverrideService;

  let zoneId: bigint;
  let otherZoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let otherZonePlantId: bigint;
  let se: string;
  let zmToken: string;
  let ohToken: string;

  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  /** Plants a single test makes for itself, so it does not depend on what ran before it. */
  const extraPlantIds: bigint[] = [];

  /** Today, as the server will compute it — the endpoint and the write share this clock. */
  const NOW = new Date();

  /**
   * One ticket at `plant`, with a device state behind it. `overrides` shapes the distractors: a
   * ticket the write would skip must be built as the real thing it is, not as a special case.
   */
  const makeTicket = async (
    plant: bigint,
    overrides: {
      status?: string;
      assignmentState?: string;
      deferredUntil?: Date | null;
      slaBucket?: string;
      inactivityHours?: number;
    } = {},
  ): Promise<string> => {
    const deviceId = String(12_730_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        slaBucket: (overrides.slaBucket ?? 'CRITICAL') as never,
        eligibleForUptime: true,
        hasOpenFailureCycle: true,
        inactivityHours: overrides.inactivityHours ?? 30,
        latestGpsDatetime: new Date(NOW.getTime() - (overrides.inactivityHours ?? 30) * 3_600_000),
        plantId: plant,
        companyId,
        computedAt: NOW,
      },
    });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: (overrides.status ?? 'OPEN') as never,
        failureCycleId: cycle.cycleId,
        deviceId,
        plantId: plant,
        companyId,
        companyTier: 'GOLD',
        assignmentState: (overrides.assignmentState ?? 'UNASSIGNED') as never,
        deferredUntil: overrides.deferredUntil ?? null,
        lastStateChangedAt: NOW,
      },
    });
    ticketIds.push(ticket.ticketId);
    return ticket.ticketId;
  };

  const fetchPool = (token: string, headers: Record<string, string> = {}) => {
    const req = request(app.getHttpServer())
      .get('/api/schedules/assignable-work')
      .set('Authorization', `Bearer ${token}`);
    for (const [k, v] of Object.entries(headers)) req.set(k, v);
    return req;
  };

  /** The plant row for `plantId` out of the company → plant tree. */
  const plantRow = (body: { companies: { plants: { plantId: string }[] }[] }, id: bigint) =>
    body.companies.flatMap((c) => c.plants).find((p) => p.plantId === String(id));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);
    override = app.get(OverrideService);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-aw-' + NS } })).zoneId;
    otherZoneId = (await prisma.zone.create({ data: { name: 'Z-aw-other-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-aw-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    // A plant has no company of its own — several companies' vehicles sit at the same site, which is
    // why the pool groups by the **ticket's** company and the same plant may appear under more than one.
    plantId = (await prisma.plant.create({ data: { name: 'P-aw-' + NS, zoneId } })).plantId;
    otherZonePlantId = (
      await prisma.plant.create({ data: { name: 'P-aw-other-' + NS, zoneId: otherZoneId } })
    ).plantId;

    const tag = randomUUID().slice(0, 8);
    const seUser = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@aw.test`, zoneId },
    });
    userIds.push(seUser.userId);
    se = seUser.userId;
    await prisma.engineerMaster.create({
      data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 50 },
    });
    await prisma.seCoverage.create({ data: { seId: se, plantId, coverageType: 'DEDICATED' } });

    const zmTag = randomUUID().slice(0, 8);
    const zmUser = await prisma.user.create({
      data: { name: 'ZM ' + zmTag, role: 'ZONAL_MANAGER', phone: 'ph-' + zmTag, email: `${zmTag}@aw.test`, zoneId },
    });
    userIds.push(zmUser.userId);
    zmToken = tokens.signAccessToken({ user_id: zmUser.userId, role: 'ZONAL_MANAGER', zone_id: Number(zoneId) });

    const ohTag = randomUUID().slice(0, 8);
    const ohUser = await prisma.user.create({
      data: { name: 'OH ' + ohTag, role: 'OPERATIONS_HEAD', phone: 'ph-' + ohTag, email: `${ohTag}@aw.test` },
    });
    userIds.push(ohUser.userId);
    ohToken = tokens.signAccessToken({ user_id: ohUser.userId, role: 'OPERATIONS_HEAD', zone_id: null });
  });

  afterAll(async () => {
    const schedules = await prisma.workSchedule.findMany({ where: { zoneId }, select: { scheduleId: true } });
    const batches = await prisma.plantBatchAssignment.findMany({
      where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } },
      select: { batchId: true },
    });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.workSchedule.deleteMany({ where: { zoneId } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seCoverage.deleteMany({ where: { plantId } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.seCoverage.deleteMany({ where: { plantId: { in: extraPlantIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [plantId, otherZonePlantId, ...extraPlantIds] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: [zoneId, otherZoneId] } } });
    await app.close();
  });

  /**
   * Slice 1 — the work pool exists and counts only work a manual assign would actually move.
   *
   * The three distractors are the whole point. Each is a real ticket at the same plant that one of the
   * two pre-existing definitions would have counted: a `VERIFICATION_PENDING` one (open in the sense
   * `plantDeviceStats` means, since it is neither resolved nor assigned to anyone), an already
   * `FORMALLY_ASSIGNED` one, and one held to a future date. Only the two genuinely assignable tickets
   * may appear in `openUnassigned`.
   */
  it('counts only OPEN + UNASSIGNED + not-held work at each plant', async () => {
    await makeTicket(plantId);
    await makeTicket(plantId, { inactivityHours: 61 });
    await makeTicket(plantId, { status: 'VERIFICATION_PENDING' });
    await makeTicket(plantId, { assignmentState: 'FORMALLY_ASSIGNED' });
    await makeTicket(plantId, { deferredUntil: new Date(NOW.getTime() + 3 * 86_400_000) });

    const res = await fetchPool(zmToken);
    expect(res.status).toBe(200);

    const row = plantRow(res.body, plantId);
    expect(row).toBeDefined();
    expect(row!.openUnassigned).toBe(2);
  });

  /**
   * Slice 2 — **AC-2, the one that matters.** The read predicts the write.
   *
   * Everything else in this file could pass with the console quietly counting a slightly different set
   * from the one the commit moves, which is precisely the failure #272 R3 was written about: a
   * dispatcher reads "12 devices at Kotputli", presses the button beside it, and 9 move. So this test
   * refuses to hardcode the expected number at all — it takes the count the API just published, runs
   * the real `assignPlants` the console commits through, and asserts the write moved exactly that
   * many, with nothing changing in between.
   *
   * It then checks the negative that gives the positive its meaning: the distractors are still where
   * they were. A write that simply assigned everything at the plant would satisfy the first assertion
   * and fail this one.
   */
  it('publishes the count the commit actually moves, and moves nothing else', async () => {
    const before = await fetchPool(zmToken);
    const published = plantRow(before.body, plantId)!.openUnassigned;
    expect(published).toBeGreaterThan(0); // a vacuous 0 = 0 would prove nothing

    const summary = await override.assignPlants(
      [String(plantId)],
      se,
      { role: 'ZONAL_MANAGER', zoneId: Number(zoneId) },
      { userId: userIds[1], role: 'ZONAL_MANAGER', actedAsRole: null },
    );
    expect('result' in summary).toBe(false);
    expect((summary as { assigned: number }).assigned).toBe(published);

    // The pool is now empty at that plant — "left after commit" is real, not retrospective.
    const after = await fetchPool(zmToken);
    expect(plantRow(after.body, plantId)?.openUnassigned ?? 0).toBe(0);

    // …and the work the predicate excludes was genuinely left alone, not swept up.
    const untouched = await prisma.ticket.findMany({
      where: { plantId, OR: [{ status: 'VERIFICATION_PENDING' }, { deferredUntil: { not: null } }] },
      select: { assignmentState: true, status: true },
    });
    expect(untouched).toHaveLength(2);
    expect(untouched.every((t) => t.assignmentState === 'UNASSIGNED')).toBe(true);
  });

  /**
   * Slice 3 — AC-3. Held work is excluded from the offer **and named**, on its own plant so the
   * assertion does not depend on what an earlier test left behind.
   *
   * Reported rather than derived by subtraction, and the plant is listed even though it has *no*
   * assignable work: a dispatcher who can see devices at a site and is offered none has to be told
   * why, or the console reads as though the work vanished and the next move is to go looking for it.
   */
  it('excludes work held to a future date, counts it separately, and still shows the plant', async () => {
    const heldPlantId = (await prisma.plant.create({ data: { name: 'P-aw-held-' + NS, zoneId } })).plantId;
    extraPlantIds.push(heldPlantId);
    const future = new Date(Date.now() + 5 * 86_400_000);
    await makeTicket(heldPlantId, { deferredUntil: future });
    await makeTicket(heldPlantId, { deferredUntil: future });

    const res = await fetchPool(zmToken);
    const row = plantRow(res.body, heldPlantId);
    expect(row).toBeDefined();
    expect(row!.openUnassigned).toBe(0);
    expect(row!.heldCount).toBe(2);
  });

  /**
   * Slice 4 — AC-4. Zone scope, including the half that is normally deferred.
   *
   * The clamp itself is the same one every manager read applies. **Acting-as-zone is the part worth
   * writing a test for**: every sibling read on this controller builds its scope straight off the JWT
   * claims, which structurally cannot carry acting (#239), so an Operations Head acting in a zone gets
   * pan-India rows. On a dashboard that is a wrong number; on a console whose entire purpose is "what
   * is left in *this* zone, and who takes it" it is an operator about to hand out another zone's work.
   * So this surface honours the header from the start, and the test pins it before #239's sweep
   * arrives to replace the inline collapse with the shared helper.
   */
  it('clamps a ZM to their zone, shows an OH every zone, and collapses an acting OH to the acted zone', async () => {
    await makeTicket(otherZonePlantId);

    const zm = await fetchPool(zmToken);
    expect(plantRow(zm.body, otherZonePlantId)).toBeUndefined();
    expect(plantRow(zm.body, plantId)).toBeDefined(); // still sees its own zone's plant (held row)

    const oh = await fetchPool(ohToken);
    expect(plantRow(oh.body, otherZonePlantId)).toBeDefined();

    // Acting in the other zone: the OH now reads as that zone's ZM — the other zone's work, and only it.
    const acting = await fetchPool(ohToken, { 'X-Acting-As-Zone': String(otherZoneId) });
    expect(plantRow(acting.body, otherZonePlantId)).toBeDefined();
    expect(plantRow(acting.body, plantId)).toBeUndefined();
  });
});
