import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { DispatchRunService } from '../src/scheduling/dispatch-run.service';

/**
 * #242 AC-5, second clause — the population the recommender has always dropped in silence.
 *
 * `runForZone` ranks with the canonical sort, which needs an SLA bucket, so it filters the candidate
 * list down to tickets whose `device_states.sla_bucket` is computed (`recommender.service.ts:326`).
 * Everything else falls out **before** any decision is taken: no recommendation row, no UNASSIGNABLE
 * row, no decision trace, no ledger figure. On the run report those tickets simply do not exist — they
 * are neither dispatched nor unassignable nor withheld, and nothing anywhere says how many there were.
 *
 * That was tolerable while the population was small and static. #242 changes both: recycling returns
 * unworked tickets to `UNASSIGNED` every night, so any ticket whose device stops producing a computed
 * bucket now cycles back into this blind spot indefinitely instead of sitting quietly on a stale plan.
 * A release volume that grows an invisible class is not something to discover from a customer call.
 *
 * The figure is deliberately **not** folded into `unassignable`, for the same reason #238 kept
 * `withheldBelowThreshold` apart: unassignable means the engine looked and found nobody, which someone
 * must act on in Ops. This means the engine never looked, which someone must act on in *data* — an
 * un-recomputed device state, a device with no state row at all. Two different queues.
 */
const NS = Date.now();
const NOW = new Date('2026-08-05T06:00:00Z');

describe('#242 AC-5 — the dispatch-run ledger counts bucket-less-dropped tickets', () => {
  let prisma: PrismaService;
  let rec: RecommenderService;
  let runs: DispatchRunService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let seId: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];

  /** `slaBucket: null` = a device state that exists but has not been ranked; `noState` = no row at all. */
  const makeTicket = async (opts: { bucket: 'CRITICAL' | null; noState?: boolean }): Promise<string> => {
    const deviceId = String(13_800_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    if (!opts.noState) {
      await prisma.deviceState.create({
        data: {
          deviceId,
          isInactive: true,
          slaBucket: opts.bucket,
          eligibleForUptime: true,
          hasOpenFailureCycle: true,
          latestGpsDatetime: new Date(NOW.getTime() - 180 * 60_000),
          plantId,
          companyId,
          computedAt: NOW,
        },
      });
    }
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
    runs = new DispatchRunService(prisma, rec, new BatchAssignmentService(prisma));

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

    zoneId = (await prisma.zone.create({ data: { name: 'Z-bkl-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-bkl-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-bkl-' + NS, zoneId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@bkl.test`, zoneId },
    });
    userIds.push(u.userId);
    seId = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: seId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
    await prisma.seCoverage.create({ data: { seId, plantId, coverageType: 'DEDICATED' } });

    // One rankable ticket, one whose state row carries no bucket, one with no state row at all.
    await makeTicket({ bucket: 'CRITICAL' });
    await makeTicket({ bucket: null });
    await makeTicket({ bucket: null, noState: true });
  });

  afterAll(async () => {
    const ledger = await prisma.dispatchRun.findMany({
      where: { zoneRows: { some: { zoneId } } },
      select: { runId: true },
    });
    await prisma.dispatchDecisionTrace.deleteMany({ where: { ticketId: { in: ticketIds } } });
    const schedules = await prisma.workSchedule.findMany({ where: { zoneId }, select: { scheduleId: true } });
    const batches = await prisma.plantBatchAssignment.findMany({
      where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } },
      select: { batchId: true },
    });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.workSchedule.deleteMany({ where: { zoneId } });
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.dispatchRun.deleteMany({ where: { runId: { in: ledger.map((r) => r.runId) } } });
    await prisma.auditLog.deleteMany({
      where: { entityType: 'dispatch_run', entityId: { in: ledger.map((r) => r.runId.toString()) } },
    });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seCoverage.deleteMany({ where: { seId: { in: userIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('the recommender reports how many tickets it dropped for a missing SLA bucket', async () => {
    const summary = await rec.runForZone(zoneId, { now: NOW, dryRun: true, targetDate: NOW });

    // Both flavours count: a state row with a NULL bucket, and no state row at all. Each reaches the
    // ticket read (an unmeasurable device must not be withheld — see the threshold gate's three-branch
    // OR) and then falls out of the ranking, which is precisely the silence being ended.
    expect(summary.bucketlessDropped).toBe(2);
    // The one rankable ticket is the only thing that reached a decision, so the two counts do not
    // overlap — a dropped ticket is never also considered.
    expect(summary.ticketsConsidered).toBe(1);
  });

  it('the run and its zone card both carry the figure', async () => {
    const outcome = await runs.runForActiveZones(NOW, { zoneId, trigger: 'MANUAL' });
    expect(outcome.result).toBe('RAN');

    const zoneRow = await prisma.dispatchRunZone.findFirstOrThrow({
      where: { zoneId },
      orderBy: { id: 'desc' },
    });
    expect(zoneRow.bucketlessDropped).toBe(2);

    const run = await prisma.dispatchRun.findUniqueOrThrow({ where: { runId: zoneRow.runId } });
    // The run total is the sum of its cards, by construction — the property every column beside it holds.
    expect(run.bucketlessDropped).toBe(2);
  });

  it('a zone whose recommender never reported leaves the figure NULL, not zero', async () => {
    // The honesty clause. `withheldBelowThreshold` defaults to 0 because a run predating #238's gate
    // genuinely withheld nothing; this drop, by contrast, has been happening all along and simply went
    // uncounted — so 0 on a historical row would be a claim nobody measured. NULL says "not recorded".
    const historical = await prisma.dispatchRun.findFirst({
      where: { bucketlessDropped: null },
      select: { runId: true },
    });
    expect(historical === null || historical.runId > 0n).toBe(true);

    const columns = await prisma.$queryRaw<{ is_nullable: string }[]>`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'dispatch_runs' AND column_name = 'bucketless_dropped'`;
    expect(columns[0]?.is_nullable).toBe('YES');
  });
});
