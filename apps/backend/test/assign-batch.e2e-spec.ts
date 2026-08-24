import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { AssignableWorkQueryService } from '../src/scheduling/assignable-work-query.service';
import { LoggingDayPlanNotifier } from '../src/scheduling/day-plan-notifier';
import { OverrideService } from '../src/scheduling/override.service';
import { raceTwiceUnbarriered } from './support/concurrency';

/**
 * #275 — `assign-batch`: one transaction per engineer lane, one result row per lane, a mandatory
 * reason, honest per-ticket skips instead of a silent drop. Exercised at the {@link OverrideService}
 * seam directly (the controller is a thin validating wrapper; `issue-122b-fleet-assign.e2e-spec.ts`
 * is the HTTP-level contract pin for `assign-plants`, which this issue re-implements on top of
 * `assignBatch` without changing its response shape).
 */
const NS = Date.now();

describe('#275 — assign-batch', () => {
  let prisma: PrismaService;
  let override: OverrideService;
  let assignableWork: AssignableWorkQueryService;

  let zoneId: bigint;
  let otherZoneId: bigint;
  let companyId: bigint;
  let plantIn: bigint;
  let plantOut: bigint;
  let se1: string;
  let se2: string;
  let se3: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  const NOW = new Date('2026-08-24T06:00:00Z');
  const ACTOR = { userId: '33333333-3333-3333-3333-333333333333', role: 'ZONAL_MANAGER', actedAsRole: null };
  const scope = { role: 'ZONAL_MANAGER', zoneId: 0 };

  const makeTicket = async (plant: bigint, opts: { deferredUntil?: Date } = {}): Promise<string> => {
    const deviceId = String(10_600_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
    const t = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        failureCycleId: cycle.cycleId,
        deviceId,
        plantId: plant,
        companyId,
        companyTier: 'GOLD',
        assignmentState: 'UNASSIGNED',
        lastStateChangedAt: NOW,
        deferredUntil: opts.deferredUntil ?? null,
      },
    });
    ticketIds.push(t.ticketId);
    return t.ticketId;
  };

  const makeSe = async (dailyCapacity = 8): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@ab.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({ data: { engineerId: u.userId, coverageType: 'MULTI_PLANT', zoneId, dailyCapacity } });
    return u.userId;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    override = new OverrideService(prisma, new AuditService(prisma), new LoggingDayPlanNotifier());
    assignableWork = new AssignableWorkQueryService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-ab-' + NS } })).zoneId;
    otherZoneId = (await prisma.zone.create({ data: { name: 'Z-ab-other-' + NS } })).zoneId;
    scope.zoneId = Number(zoneId);
    companyId = (
      await prisma.company.create({ data: { name: 'Co-ab-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantIn = (await prisma.plant.create({ data: { name: 'P-ab-in-' + NS, zoneId } })).plantId;
    plantOut = (await prisma.plant.create({ data: { name: 'P-ab-out-' + NS, zoneId: otherZoneId } })).plantId;

    se1 = await makeSe();
    se2 = await makeSe();
    se3 = await makeSe(2); // low capacity — the over-capacity non-gate test
  });

  afterAll(async () => {
    const seIds = [se1, se2, se3];
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: ticketIds } }, { entityId: { in: seIds } }] } });
    await prisma.batchAssignmentTicket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { seId: { in: seIds } } });
    await prisma.workSchedule.deleteMany({ where: { seId: { in: seIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: seIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [plantIn, plantOut] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: [zoneId, otherZoneId] } } });
    await prisma.$disconnect();
  });

  it('commits a three-lane batch as three transactions; a throwing lane leaves the others committed', async () => {
    const t1 = await makeTicket(plantIn);
    const t3 = await makeTicket(plantIn);
    const out = await override.assignBatch(
      [
        { seId: se1, ticketIds: [t1] },
        // Not a real ticket_id — `tickets.ticket_id` is `uuid`, so this errors inside lane 2's own
        // transaction rather than resolving to an honest NOT_FOUND skip. That is the point: it proves
        // an unexpected failure aborts only its own lane.
        { seId: se2, ticketIds: ['not-a-uuid'] },
        { seId: se3, ticketIds: [t3] },
      ],
      'three-lane isolation test',
      scope,
      ACTOR,
      NOW,
    );

    expect(out.lanes).toHaveLength(3);
    expect(out.lanes[0]).toMatchObject({ seId: se1, result: 'OK', assigned: 1 });
    expect(out.lanes[1]).toMatchObject({ seId: se2, result: 'LANE_FAILED' });
    expect(out.lanes[2]).toMatchObject({ seId: se3, result: 'OK', assigned: 1 });

    const rows = await prisma.ticket.findMany({ where: { ticketId: { in: [t1, t3] } } });
    expect(rows.every((r) => r.assignmentState === 'FORMALLY_ASSIGNED')).toBe(true);
  });

  it('every assigned ticket gets an audit row shaped like a single assignTicket, plus one reason row per lane', async () => {
    const t = await makeTicket(plantIn);
    const out = await override.assignBatch([{ seId: se1, ticketIds: [t] }], 'audit parity check', scope, ACTOR, NOW);
    expect(out.lanes[0]).toMatchObject({ result: 'OK', assigned: 1 });

    const ticketRow = await prisma.auditLog.findFirst({
      where: { entityType: 'ticket', entityId: t },
      orderBy: { id: 'desc' },
    });
    expect(ticketRow).toMatchObject({
      actorId: ACTOR.userId,
      actorRole: ACTOR.role,
      entityType: 'ticket',
      entityId: t,
    });
    expect(ticketRow?.metadata).toMatchObject({ seId: se1 });

    const laneRow = await prisma.auditLog.findFirst({
      where: { action: 'ASSIGN_BATCH_COMMIT', entityId: se1 },
      orderBy: { id: 'desc' },
    });
    expect(laneRow?.metadata).toMatchObject({ reasonCode: 'audit parity check', ticketIds: [t], assigned: 1 });
  });

  it('an out-of-zone ticket is skipped by name, and the lane still succeeds', async () => {
    const inZone = await makeTicket(plantIn);
    const outZone = await makeTicket(plantOut);
    const out = await override.assignBatch(
      [{ seId: se1, ticketIds: [inZone, outZone] }],
      'zone skip test',
      scope,
      ACTOR,
      NOW,
    );
    const lane = out.lanes[0];
    expect(lane.result).toBe('OK');
    expect(lane.assigned).toBe(1);
    expect(lane.skipped).toContainEqual({ ticketId: outZone, reason: 'OUT_OF_ZONE' });
  });

  it('a deferred ticket is skipped as CONFLICT_DEFERRED, never silently dropped', async () => {
    const held = await makeTicket(plantIn, { deferredUntil: new Date('2026-08-30') });
    const out = await override.assignBatch([{ seId: se1, ticketIds: [held] }], 'deferral skip test', scope, ACTOR, NOW);
    expect(out.lanes[0]).toMatchObject({ result: 'OK', assigned: 0 });
    expect(out.lanes[0].skipped).toContainEqual({ ticketId: held, reason: 'CONFLICT_DEFERRED' });
  });

  it('commits to an over-capacity engineer with no confirm step and no extra audit requirement (Q2 regression pin)', async () => {
    const tickets = await Promise.all([1, 2, 3, 4, 5].map(() => makeTicket(plantIn)));
    // se3's dailyCapacity is 2 — five tickets is over capacity, and this call carries no confirm flag.
    const out = await override.assignBatch([{ seId: se3, ticketIds: tickets }], 'overload allowed', scope, ACTOR, NOW);
    expect(out.lanes[0]).toMatchObject({ result: 'OK', assigned: 5 });
  });

  it('two lanes racing the same ticket: exactly one assigns it, the other reports a clean skip — never a 500', async () => {
    // Start-together race (no injection point in assignBatch to barrier on) — the invariant asserted
    // below (exactly one winner, no throw) is the sensitive part; see #265's own precedent for why an
    // unbarriered pair is kept and its limitation stated rather than assumed reliable.
    const t = await makeTicket(plantIn);
    const results = await raceTwiceUnbarriered(() =>
      override.assignBatch([{ seId: se1, ticketIds: [t] }], 'race', scope, ACTOR, NOW),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    const assignedCount = results.reduce(
      (n, r) => n + (r.ok ? r.value.lanes[0].assigned : 0),
      0,
    );
    expect(assignedCount).toBe(1);
    const row = await prisma.ticket.findUnique({ where: { ticketId: t } });
    expect(row?.assignmentState).toBe('FORMALLY_ASSIGNED');
  });

  it('assignPlants delegates to the same lane primitive and keeps its PlantAssignSummary shape', async () => {
    const t = await makeTicket(plantIn);
    const summary = await override.assignPlants([String(plantIn)], se1, scope, ACTOR, NOW);
    if ('result' in summary) throw new Error('expected a PlantAssignSummary');
    expect(summary.seId).toBe(se1);
    expect(summary.assigned).toBeGreaterThanOrEqual(1);
    const plantRow = summary.perPlant.find((p) => p.plantId === String(plantIn));
    expect(plantRow).toBeDefined();
    const row = await prisma.ticket.findUnique({ where: { ticketId: t } });
    expect(row?.assignmentState).toBe('FORMALLY_ASSIGNED');
  });

  it('resolves a draft plant into the exact ticket ids assign-batch will commit — the review screen seam', async () => {
    const t1 = await makeTicket(plantIn);
    const t2 = await makeTicket(plantIn);
    const resolved = await assignableWork.ticketIdsForPlants(scope, [plantIn], NOW);
    const row = resolved.find((r) => r.plantId === String(plantIn));
    expect(row?.ticketIds).toEqual(expect.arrayContaining([t1, t2]));

    const out = await override.assignBatch(
      [{ seId: se1, ticketIds: row!.ticketIds }],
      'resolved-plant commit',
      scope,
      ACTOR,
      NOW,
    );
    expect(out.lanes[0].assigned).toBe(row!.ticketIds.length);
  });

  it('the review screen\'s "still unassigned after" arithmetic equals the real post-commit assignable-work total', async () => {
    const before = await assignableWork.listForScope(scope, NOW);
    const t1 = await makeTicket(plantIn);
    const t2 = await makeTicket(plantIn);
    const afterSeed = await assignableWork.listForScope(scope, NOW);
    expect(afterSeed.totals.openUnassigned).toBe(before.totals.openUnassigned + 2);

    // The review screen's own arithmetic: openTotal − committingTotal.
    const predictedAfterCommit = afterSeed.totals.openUnassigned - 2;

    await override.assignBatch([{ seId: se1, ticketIds: [t1, t2] }], 'end-to-end ledger check', scope, ACTOR, NOW);

    const post = await assignableWork.listForScope(scope, NOW);
    expect(post.totals.openUnassigned).toBe(predictedAfterCommit);
  });
});
