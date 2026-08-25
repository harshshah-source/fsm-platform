import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { DispatchRunService } from '../src/scheduling/dispatch-run.service';

/**
 * #286 AC2/AC3/AC4 — same-day recovery against #258's guarantees, on real tickets.
 *
 * `dispatch-crashed-zone-recovery.e2e-spec.ts` pins the mechanism with stubs. This one runs the real
 * recommender and the real dispatcher over seeded work, because the three properties below are
 * properties of what lands on engineers' day plans, and a stub that reports `{tickets: 0}` cannot
 * disagree with any of them:
 *
 *  - **G1, effectively-once** — the dead run's committed per-SE transactions stand, and the recovery
 *    does not place their tickets a second time.
 *  - **G2, zone independence** — the crash and the recovery are both invisible to every other zone.
 *  - **G5, no permanent RUNNING** — nothing anywhere in the sequence is left claiming to be in flight.
 */
const NS = Date.now();
const NOW = new Date('2026-06-21T06:00:00Z');
const DAY = new Date(Date.UTC(2026, 5, 21));

interface Seeded {
  zoneId: bigint;
  plantId: bigint;
  seId: string;
  ticketIds: string[];
}

describe('#286 — same-day recovery keeps G1, G2 and G5 (e2e)', () => {
  let prisma: PrismaService;
  let service: DispatchRunService;

  const zoneIds: bigint[] = [];
  const companyIds: bigint[] = [];
  const plantIds: bigint[] = [];
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  const runIds: bigint[] = [];

  const seedZone = async (label: string, nTickets: number): Promise<Seeded> => {
    const zoneId = (await prisma.zone.create({ data: { name: `Z-${label}-${NS}` } })).zoneId;
    zoneIds.push(zoneId);
    const companyId = (
      await prisma.company.create({ data: { name: `Co-${label}-${NS}`, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    companyIds.push(companyId);
    const plantId = (await prisma.plant.create({ data: { name: `P-${label}-${NS}`, zoneId } })).plantId;
    plantIds.push(plantId);

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: `SE ${tag}`, role: 'SERVICE_ENGINEER', phone: `ph-${tag}`, email: `${tag}@recovery.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({
      data: { engineerId: u.userId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 },
    });
    await prisma.seCoverage.create({ data: { seId: u.userId, plantId, coverageType: 'DEDICATED' } });

    const tIds: string[] = [];
    for (let i = 0; i < nTickets; i++) {
      const deviceId = String(9_386_000_000 + (NS % 100_000) * 10 + deviceIds.length);
      deviceIds.push(deviceId);
      await prisma.device.create({ data: { deviceId } });
      await prisma.deviceState.create({
        data: {
          deviceId,
          isInactive: true,
          slaBucket: 'CRITICAL',
          eligibleForUptime: true,
          hasOpenFailureCycle: true,
          latestGpsDatetime: new Date(NOW.getTime() - (90 + i * 30) * 60_000),
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
      tIds.push(t.ticketId);
    }
    return { zoneId, plantId, seId: u.userId, ticketIds: tIds };
  };

  /**
   * Rewind a finished run to the instant before it finalized, and kill it there.
   *
   * This is the crash AC3 is about, and it has to be staged this way to be the real one: the run's
   * per-SE transactions **committed** (real day plans, real ticket rows) and then the process stopped
   * existing. A fabricated dead run that never dispatched anything would prove only that recovery works
   * on an empty zone.
   */
  const killAfterCommitting = async (runId: bigint): Promise<void> => {
    await prisma.dispatchRun.update({
      where: { runId },
      // An hour before the run's own `now`, not before the wall clock: every call in this spec is
      // driven from `NOW`, and a beat measured against the real clock would sit in the future of the
      // reap that has to judge it.
      data: { status: 'RUNNING', finishedAt: null, heartbeatAt: new Date(NOW.getTime() - 60 * 60 * 1000) },
    });
    await prisma.dispatchRunZone.updateMany({
      where: { runId },
      data: { status: 'RUNNING', finishedAt: null, error: null },
    });
  };

  const placementsFor = (ids: string[]) =>
    prisma.batchAssignmentTicket.findMany({ where: { ticketId: { in: ids }, removedAt: null } });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new DispatchRunService(
      prisma,
      new RecommenderService(prisma, new CandidateSelectionService(prisma)),
      new BatchAssignmentService(prisma),
    );
  });

  afterAll(async () => {
    await prisma.dispatchZoneRecovery.deleteMany({ where: { zoneId: { in: zoneIds } } });
    await prisma.dispatchDecisionTrace.deleteMany({ where: { ticketId: { in: ticketIds } } });
    const schedules = await prisma.workSchedule.findMany({
      where: { zoneId: { in: zoneIds } },
      select: { scheduleId: true },
    });
    const batches = await prisma.plantBatchAssignment.findMany({
      where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } },
      select: { batchId: true },
    });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.workSchedule.deleteMany({ where: { zoneId: { in: zoneIds } } });
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    const zoneRuns = await prisma.dispatchRunZone.findMany({
      where: { zoneId: { in: zoneIds } },
      select: { runId: true },
    });
    await prisma.dispatchRunZone.deleteMany({ where: { zoneId: { in: zoneIds } } });
    await prisma.dispatchRun.deleteMany({ where: { runId: { in: [...runIds, ...zoneRuns.map((r) => r.runId)] } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seCoverage.deleteMany({ where: { plantId: { in: plantIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: plantIds } } });
    await prisma.company.deleteMany({ where: { companyId: { in: companyIds } } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: zoneIds } } });
    await prisma.onModuleDestroy();
  });

  /**
   * AC3 + AC4 + AC1 in one sequence, because they are one sequence: the run commits, dies, is reaped,
   * is recovered, and at the end every ticket must be on exactly one day plan and nothing may still
   * claim to be running.
   */
  it('recovers a zone whose run died after committing — nothing is dispatched twice, nothing stays RUNNING', async () => {
    const z = await seedZone('g1', 2);

    const first = await service.runForActiveZones(NOW, { zoneId: z.zoneId, trigger: 'CRON' });
    expect(first.result).toBe('RAN');
    if (first.result !== 'RAN') return;
    expect(first.summary.tickets).toBe(2);
    const deadRunId = BigInt(first.summary.runId);
    runIds.push(deadRunId);
    const committed = await placementsFor(z.ticketIds);
    expect(committed).toHaveLength(2);

    await killAfterCommitting(deadRunId);
    await service.reapStaleDispatchRuns(NOW);
    const outcome = await service.recoverMarkedZones(NOW);
    expect(outcome.recovered).toBe(1);

    // G1 — the committed work stands and is not duplicated. Asserted on the ticket's own rows, not on
    // a counter the run reported: a second placement is what an operator would actually see.
    const after = await placementsFor(z.ticketIds);
    expect(after).toHaveLength(2);
    expect(after.map((p) => p.batchId).sort()).toEqual(committed.map((p) => p.batchId).sort());
    for (const ticketId of z.ticketIds) {
      expect((await prisma.ticket.findUniqueOrThrow({ where: { ticketId } })).assignmentState).toBe(
        'FORMALLY_ASSIGNED',
      );
    }
    // And exactly one live day plan for that engineer — the backstop index's own invariant.
    const live = await prisma.workSchedule.findMany({
      where: { zoneId: z.zoneId, seId: z.seId, dateFrom: DAY, status: 'ACTIVE' },
    });
    expect(live).toHaveLength(1);

    // G5 — no permanent RUNNING anywhere in the sequence.
    expect(await prisma.dispatchRunZone.count({ where: { zoneId: z.zoneId, status: 'RUNNING' } })).toBe(0);
    const zoneRunIds = (
      await prisma.dispatchRunZone.findMany({ where: { zoneId: z.zoneId }, select: { runId: true } })
    ).map((r) => r.runId);
    expect(await prisma.dispatchRun.count({ where: { runId: { in: zoneRunIds }, status: 'RUNNING' } })).toBe(0);
    expect((await prisma.dispatchRun.findUniqueOrThrow({ where: { runId: deadRunId } })).status).toBe('ABORTED');
  });

  /**
   * AC2 — G2, from both directions. A neighbouring zone must be untouched by the crash *and* by the
   * repair: no re-plan, no second run, and not so much as a recovery mark of its own.
   */
  it('leaves every other zone alone — no mark, no re-run, no change to its day plan', async () => {
    const crashed = await seedZone('g2-crashed', 1);
    const neighbour = await seedZone('g2-neighbour', 1);

    const healthy = await service.runForActiveZones(NOW, { zoneId: neighbour.zoneId, trigger: 'CRON' });
    expect(healthy.result).toBe('RAN');
    if (healthy.result !== 'RAN') return;
    runIds.push(BigInt(healthy.summary.runId));
    const neighbourPlanBefore = await prisma.workSchedule.findMany({
      where: { zoneId: neighbour.zoneId },
      orderBy: { scheduleId: 'asc' },
    });
    const neighbourRunsBefore = await prisma.dispatchRunZone.count({ where: { zoneId: neighbour.zoneId } });

    const dying = await service.runForActiveZones(NOW, { zoneId: crashed.zoneId, trigger: 'CRON' });
    expect(dying.result).toBe('RAN');
    if (dying.result !== 'RAN') return;
    runIds.push(BigInt(dying.summary.runId));
    await killAfterCommitting(BigInt(dying.summary.runId));

    await service.reapStaleDispatchRuns(NOW);
    await service.recoverMarkedZones(NOW);

    // The neighbour was never owed a day, so it was never marked...
    expect(await prisma.dispatchZoneRecovery.count({ where: { zoneId: neighbour.zoneId } })).toBe(0);
    // ...never re-admitted...
    expect(await prisma.dispatchRunZone.count({ where: { zoneId: neighbour.zoneId } })).toBe(neighbourRunsBefore);
    // ...and its plan is byte-for-byte the plan it had before the neighbouring zone crashed.
    const neighbourPlanAfter = await prisma.workSchedule.findMany({
      where: { zoneId: neighbour.zoneId },
      orderBy: { scheduleId: 'asc' },
    });
    expect(neighbourPlanAfter).toEqual(neighbourPlanBefore);

    // Meanwhile the crashed zone did get its day back.
    expect((await prisma.dispatchZoneRecovery.findFirstOrThrow({ where: { zoneId: crashed.zoneId } })).state).toBe(
      'RECOVERED',
    );
  });
});
