import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';

/**
 * Issue 126 (audit NEW-1) — a rolled-back `dispatchForZone` must not permanently wedge the zone.
 *
 * The recommender writes SUGGESTED recs OUTSIDE the dispatch transaction. When a pre-existing ACTIVE
 * `ZM_MANUAL` work_schedule for one SE (exactly what `override.ensureSchedule` produces) makes the
 * zone-wide dispatch tx P2002 → rollback → skip, those SUGGESTED recs survive with their tickets still
 * OPEN/UNASSIGNED. On today's (pre-fix) code the NEXT `runForZone` P2002s against
 * `recommendations_one_suggested_per_ticket` — forever — even after the triggering schedule is gone.
 *
 * The fix: (1) the recommender clears finalized/null-run orphan SUGGESTED recs for the zone before
 * (re)suggesting and guards its own create (skip a concurrent RUNNING run's ticket, never throw);
 * (2) `dispatchForZone` cleans its own run's orphans on rollback and records the skip reason.
 */
const NS = Date.now();

describe('Issue 126 — dispatch zone-wedge via orphaned SUGGESTED recs', () => {
  let prisma: PrismaService;
  let rec: RecommenderService;
  let dispatch: BatchAssignmentService;

  const NOW = new Date('2026-06-21T06:00:00Z');
  const DAY = new Date(Date.UTC(2026, 5, 21)); // UTC midnight of NOW — the Day Plan coverage date

  // Everything created, tracked for teardown across all scenarios.
  const zoneIds: bigint[] = [];
  const companyIds: bigint[] = [];
  const plantIds: bigint[] = [];
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  const runIds: bigint[] = [];

  interface Scenario {
    zoneId: bigint;
    plantId: bigint;
    seId: string;
    ticketIds: string[];
  }

  /** Isolated zone + company + plant + one DEDICATED SE + `nTickets` OPEN/UNASSIGNED TROUBLESHOOT tickets. */
  const seedScenario = async (label: string, nTickets: number, opts: { conflict?: boolean } = {}): Promise<Scenario> => {
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
      data: { name: `SE ${tag}`, role: 'SERVICE_ENGINEER', phone: `ph-${tag}`, email: `${tag}@wedge.test`, zoneId },
    });
    userIds.push(u.userId);
    const seId = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: seId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
    await prisma.seCoverage.create({ data: { seId, plantId, coverageType: 'DEDICATED' } });

    const tIds: string[] = [];
    for (let i = 0; i < nTickets; i++) {
      const deviceId = String(9_126_000_000 + (NS % 100_000) * 100 + deviceIds.length);
      deviceIds.push(deviceId);
      await prisma.device.create({ data: { deviceId } });
      await prisma.deviceState.create({
        data: {
          deviceId,
          isInactive: true,
          slaBucket: 'CRITICAL',
          eligibleForUptime: true,
          hasOpenFailureCycle: true,
          latestGpsDatetime: new Date(NOW.getTime() - (60 + i * 30) * 60_000),
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
      tIds.push(ticket.ticketId);
    }

    if (opts.conflict) {
      // A ZM override's ACTIVE ZM_MANUAL schedule already occupies this SE/zone/day (as
      // override.ensureSchedule creates) — the dispatch write will collide with it and roll back.
      await prisma.workSchedule.create({
        data: { seId, zoneId, dateFrom: DAY, dateTo: DAY, status: 'ACTIVE', source: 'ZM_MANUAL', dispatchedAt: NOW },
      });
    }
    return { zoneId, plantId, seId, ticketIds: tIds };
  };

  const newRun = async (
    status: 'RUNNING' | 'PARTIAL' | 'SUCCESS' | 'FAILED' | 'ABORTED' = 'RUNNING',
  ): Promise<bigint> => {
    const run = await prisma.dispatchRun.create({
      data: { trigger: 'MANUAL', startedAt: NOW, configSnapshot: {}, status, finishedAt: status === 'RUNNING' ? null : NOW },
    });
    runIds.push(run.runId);
    return run.runId;
  };

  const suggestedFor = (ids: string[]) =>
    prisma.recommendation.findMany({ where: { ticketId: { in: ids }, status: 'SUGGESTED' } });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    rec = new RecommenderService(prisma, new CandidateSelectionService(prisma));
    dispatch = new BatchAssignmentService(prisma);
  });

  afterAll(async () => {
    await prisma.dispatchDecisionTrace.deleteMany({ where: { ticketId: { in: ticketIds } } });
    const schedules = await prisma.workSchedule.findMany({ where: { zoneId: { in: zoneIds } }, select: { scheduleId: true } });
    const batches = await prisma.plantBatchAssignment.findMany({
      where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } },
      select: { batchId: true },
    });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.workSchedule.deleteMany({ where: { zoneId: { in: zoneIds } } });
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.dispatchRunZone.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.dispatchRun.deleteMany({ where: { runId: { in: runIds } } });
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

  it('a pre-existing ACTIVE schedule no longer drops the zone — the recommended work appends to it', async () => {
    const s = await seedScenario('wedge', 2, { conflict: true });

    // A ZM_MANUAL ACTIVE schedule already occupies this SE/zone/day. Pre-fix the zone-wide dispatch tx
    // P2002'd on `work_schedules_one_active_per_se_zone_day`, rolled back the whole zone, and orphaned
    // the SUGGESTED recs (the wedge + the "recommended but never dispatched" leak). Now dispatch REUSES
    // that schedule and APPENDS the recommended tickets onto it — nothing dropped, no rollback, no orphans.
    const run1 = await newRun();
    const rec1 = await rec.runForZone(s.zoneId, { now: NOW, runId: run1 });
    expect(rec1.recommended).toBe(2);
    const dispatch1 = await dispatch.dispatchForZone(s.zoneId, { dateFrom: DAY, dateTo: DAY, now: NOW, runId: run1 });
    expect(dispatch1.tickets).toBe(2); // appended, not dropped — reconciles with rec1.recommended
    expect(dispatch1.skipReason).toBeUndefined(); // no SCHEDULE_CONFLICT skip

    // Exactly one ACTIVE schedule — the pre-existing ZM_MANUAL one, now carrying the appended stops.
    const schedules = await prisma.workSchedule.findMany({ where: { zoneId: s.zoneId, status: 'ACTIVE' } });
    expect(schedules).toHaveLength(1);
    expect(schedules[0].source).toBe('ZM_MANUAL');

    // Both tickets committed; no orphaned SUGGESTED rec left behind (there was no rollback to orphan them).
    const tix = await prisma.ticket.findMany({ where: { ticketId: { in: s.ticketIds } } });
    expect(tix.every((t) => t.assignmentState === 'FORMALLY_ASSIGNED')).toBe(true);
    const orphans = await suggestedFor(s.ticketIds);
    expect(orphans).toHaveLength(0);
  });

  it('idempotent re-run after a successful dispatch places nothing new and does not throw', async () => {
    const s = await seedScenario('idem', 2);

    const run1 = await newRun();
    await rec.runForZone(s.zoneId, { now: NOW, runId: run1 });
    const first = await dispatch.dispatchForZone(s.zoneId, { dateFrom: DAY, dateTo: DAY, now: NOW, runId: run1 });
    expect(first.tickets).toBe(2);
    await prisma.dispatchRun.update({ where: { runId: run1 }, data: { status: 'SUCCESS', finishedAt: NOW } });

    // Re-run the same day: tickets are FORMALLY_ASSIGNED, so nothing is re-selected or re-dispatched.
    const run2 = await newRun();
    const rec2 = await rec.runForZone(s.zoneId, { now: NOW, runId: run2 });
    expect(rec2.recommended).toBe(0);
    const second = await dispatch.dispatchForZone(s.zoneId, { dateFrom: DAY, dateTo: DAY, now: NOW, runId: run2 });
    expect(second.tickets).toBe(0);
  });

  it('guard-path: a FINALIZED-run orphan is cleared and re-suggested fresh, even with cleanup skipped', async () => {
    const s = await seedScenario('finalized-orphan', 1);

    // Simulate a crash-window orphan: a SUGGESTED rec owned by an already-finalized run, with NO
    // dispatch cleanup having run (the process died between rollback and cleanup).
    const staleRun = await newRun('PARTIAL');
    await prisma.recommendation.create({
      data: { ticketId: s.ticketIds[0], seId: s.seId, status: 'SUGGESTED', path: 'MORNING_BATCH', scoreBreakdown: {}, runId: staleRun },
    });

    // The recommender clears the finalized-run orphan and re-suggests fresh — no throw.
    const freshRun = await newRun();
    const out = await rec.runForZone(s.zoneId, { now: NOW, runId: freshRun });
    expect(out.recommended).toBe(1);
    const live = await suggestedFor(s.ticketIds);
    expect(live).toHaveLength(1); // exactly the fresh set, stale orphan gone
    expect(live[0].runId).toBe(freshRun);
  });

  /**
   * #261 item 6 — recovery semantics after the reaper aborts a run, **verified rather than assumed**.
   *
   * The claim is that ABORTED needs no new cleanup because `clearFinalizedOrphans` already collects
   * SUGGESTED recs whose run is not RUNNING. That is true only by construction of a predicate written
   * before ABORTED existed, and it is precisely the sort of thing a new enum value silently breaks: had
   * the predicate been an allow-list of terminal statuses instead of `not: 'RUNNING'`, an aborted run's
   * orphans would be immortal and would wedge the zone exactly the way Issue 126 describes.
   *
   * G1 (a ticket is dispatched at most once) is asserted on the ticket's own rows, not on the counter:
   * the ticket must end with exactly one live recommendation and one schedule entry.
   */
  it('#261: an ABORTED run’s orphan is cleared, and its ticket is dispatched exactly once', async () => {
    const s = await seedScenario('aborted-orphan', 1);

    // The wreckage a reaped run leaves: it got as far as suggesting, then its process stopped existing
    // and the reaper marked it ABORTED without ever dispatching the suggestion.
    const abortedRun = await newRun('ABORTED');
    await prisma.recommendation.create({
      data: { ticketId: s.ticketIds[0], seId: s.seId, status: 'SUGGESTED', path: 'MORNING_BATCH', scoreBreakdown: {}, runId: abortedRun },
    });

    const freshRun = await newRun();
    const out = await rec.runForZone(s.zoneId, { now: NOW, runId: freshRun });
    expect(out.recommended).toBe(1);

    // Re-evaluated, not inherited: the surviving suggestion belongs to the new run.
    const live = await suggestedFor(s.ticketIds);
    expect(live).toHaveLength(1);
    expect(live[0].runId).toBe(freshRun);

    // And dispatching it lands the ticket on exactly one day plan — the aborted run contributed no
    // second assignment, which is G1 stated on the rows rather than on a count the run reported.
    const dispatched = await dispatch.dispatchForZone(s.zoneId, { dateFrom: DAY, dateTo: DAY, now: NOW, runId: freshRun });
    expect(dispatched.tickets).toBe(1);
    const placed = await prisma.batchAssignmentTicket.findMany({
      where: { ticketId: s.ticketIds[0], removedAt: null },
    });
    expect(placed).toHaveLength(1);
  });

  it('guard-path: a RUNNING-run orphan is left intact and its ticket is skipped (no throw)', async () => {
    const s = await seedScenario('running-orphan', 1);

    // A concurrent, still-RUNNING dispatch run already holds a live SUGGESTED for this ticket.
    const concurrentRun = await newRun('RUNNING');
    const held = await prisma.recommendation.create({
      data: { ticketId: s.ticketIds[0], seId: s.seId, status: 'SUGGESTED', path: 'MORNING_BATCH', scoreBreakdown: {}, runId: concurrentRun },
    });

    // The recommender must NOT throw and must NOT delete the concurrent run's rec — it skips the ticket.
    const freshRun = await newRun();
    const out = await rec.runForZone(s.zoneId, { now: NOW, runId: freshRun });
    expect(out.recommended).toBe(0); // ticket skipped — the RUNNING run owns it
    const live = await suggestedFor(s.ticketIds);
    expect(live).toHaveLength(1);
    expect(live[0].recommendationId).toBe(held.recommendationId); // untouched
    expect(live[0].runId).toBe(concurrentRun);
  });
});
