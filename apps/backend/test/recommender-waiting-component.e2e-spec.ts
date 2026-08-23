import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import { SeAvailabilityService } from '../src/engineers/se-availability.service';
import { IntradayInsertionService } from '../src/intraday/intraday-insertion.service';
import { NotificationService } from '../src/notifications/notification.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { LoggingDayPlanNotifier } from '../src/scheduling/day-plan-notifier';
import { DispatchRunService } from '../src/scheduling/dispatch-run.service';
import { OverrideService } from '../src/scheduling/override.service';

/**
 * #177 AC-1 (morning leg) and AC-2 — the recommender must not hand out work that cannot be done.
 *
 * A component-blocked ticket stays `OPEN` by design (ADR-0008): the failure cycle moves to
 * `WAITING_COMPONENT`, the SLA pauses, the part goes on order, and the ticket waits. The recommender's
 * selection has never looked at the cycle at all — `workType + status + assignmentState + deferral +
 * plant/device guards` and nothing else — so the moment such a ticket is also `UNASSIGNED` it is
 * dispatched like any other. The SE drives out, cannot fix it, and submits `componentUnavailable`
 * again, which opens a **second** live `component_request` (the only unique on that table is
 * `submission_id`). A burned capacity slot, a wasted visit, and two live part requests.
 *
 * The exclusion is a **cycle-state** filter, not a "has ever been blocked" filter, and the difference
 * is the whole of AC-2. `confirmResubmit`'s floating-SE `RETURN_TO_POOL` unassigns a ticket *after*
 * the part has landed and the cycle is back to `OPEN` — that re-dispatch is correct and is the normal
 * way component-blocked work resumes. A filter keyed on anything but the live state would strand it.
 *
 * **On the NULL-relation trap, measured rather than assumed.** `recommender.service.ts` carries a
 * measured warning that Prisma renders a negated to-one relation filter such that a row whose relation
 * is NULL matches **neither the filter nor its negation**, so the natural spelling
 * `NOT: { failureCycle: { is: { state: 'WAITING_COMPONENT' } } }` would drop every cycle-less ticket
 * silently. `failure_cycle_id` is nullable, so the first draft of this test built such a ticket to pin
 * it — and the database refused: `tickets_troubleshoot_requires_cycle` (`20260620124718:254`) is
 * `work_type <> 'TROUBLESHOOT' OR failure_cycle_id IS NOT NULL`. The morning pool selects
 * `workType: 'TROUBLESHOOT'`, so the dangerous class **cannot exist here** and the naive spelling would
 * in fact be safe on this query.
 *
 * It is still not what ships, and the last test says why: that safety is an emergent property of two
 * independent facts (this constraint, plus RECOVERY/INSTALL tickets being created `REQUESTED` rather
 * than `OPEN`), neither of which the filter states or owns. The intraday sweep this issue also fixes
 * has **no `workType` clause at all**, so the same spelling there is genuinely exposed. One correct
 * spelling in both places, and a test that fails loudly if the assumption underneath ever moves.
 */
const NS = Date.now();
const NOW = new Date('2026-08-05T06:00:00Z');

describe('#177 — the recommender does not dispatch component-blocked tickets', () => {
  let prisma: PrismaService;
  let rec: RecommenderService;
  let intraday: IntradayInsertionService;
  let runs: DispatchRunService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let seId: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];

  let tOpen: string;
  let tBlocked: string;

  /** One rankable CRITICAL ticket at the shared plant, carrying a cycle in the given state. */
  const makeTicket = async (cycle: 'OPEN' | 'WAITING_COMPONENT'): Promise<string> => {
    const deviceId = String(17_700_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        hasOpenFailureCycle: true,
        latestGpsDatetime: new Date(NOW.getTime() - 180 * 60_000),
        plantId,
        companyId,
        computedAt: NOW,
      },
    });
    const blocked = cycle === 'WAITING_COMPONENT';
    const cycleRow = await prisma.failureCycle.create({
      data: {
        deviceId,
        state: cycle,
        openedAt: NOW,
        // The pause is what a real WAITING_COMPONENT cycle carries; it is deliberately NOT what the
        // filter keys on, so a cycle returned to OPEN with pause history still re-dispatches (AC-2).
        slaPaused: blocked,
        slaPauseReason: blocked ? 'WAITING_COMPONENT' : null,
        slaPausedAt: blocked ? NOW : null,
      },
    });
    const t = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        failureCycleId: cycleRow.cycleId,
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
    intraday = new IntradayInsertionService(
      prisma,
      new CandidateSelectionService(prisma),
      new OverrideService(prisma, new AuditService(prisma), new LoggingDayPlanNotifier()),
      new NotificationService(prisma),
      new SeAvailabilityService(prisma),
      new AuditService(prisma),
    );

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

    zoneId = (await prisma.zone.create({ data: { name: 'Z-wc-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-wc-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-wc-' + NS, zoneId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@wc.test`, zoneId },
    });
    userIds.push(u.userId);
    seId = u.userId;
    await prisma.engineerMaster.create({
      data: { engineerId: seId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 },
    });
    await prisma.seCoverage.create({ data: { seId, plantId, coverageType: 'DEDICATED' } });

    tOpen = await makeTicket('OPEN');
    tBlocked = await makeTicket('WAITING_COMPONENT');
  });

  afterAll(async () => {
    const ledger = await prisma.dispatchRun.findMany({
      where: { zoneRows: { some: { zoneId } } },
      select: { runId: true },
    });
    const schedules = await prisma.workSchedule.findMany({ where: { zoneId }, select: { scheduleId: true } });
    const batches = await prisma.plantBatchAssignment.findMany({
      where: { scheduleId: { in: schedules.map((sc) => sc.scheduleId) } },
      select: { batchId: true },
    });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.workSchedule.deleteMany({ where: { zoneId } });
    const notes = await prisma.notification.findMany({
      where: { recipientUserId: { in: userIds } },
      select: { id: true },
    });
    await prisma.notificationDelivery.deleteMany({ where: { notificationId: { in: notes.map((n) => n.id) } } });
    await prisma.notification.deleteMany({ where: { id: { in: notes.map((n) => n.id) } } });
    await prisma.intradayInsertion.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.dispatchDecisionTrace.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
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
    await prisma.dispatchRun.deleteMany({ where: { runId: { in: ledger.map((r) => r.runId) } } });
    await prisma.auditLog.deleteMany({
      where: { entityType: 'dispatch_run', entityId: { in: ledger.map((r) => r.runId.toString()) } },
    });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('a WAITING_COMPONENT ticket is never reached; an OPEN-cycle one at the same plant is', async () => {
    const summary = await rec.runForZone(zoneId, { now: NOW, dryRun: true, targetDate: NOW });
    const decided = (summary.projection?.decisions ?? []).map((d) => d.ticketId);

    // The blocked ticket is excluded from the pool, so it reaches no decision at all — not recommended,
    // and equally not "unassignable", which would file a policy hold in the Ops coverage-gap queue.
    expect(decided).not.toContain(tBlocked);
    expect(decided).toContain(tOpen);

    // Nothing was quietly reclassified: one ticket entered the loop, and the blocked one is absent
    // from both outcomes rather than sitting in the unassignable tally.
    expect(summary.ticketsConsidered).toBe(1);
    expect(summary.unassignable).toBe(0);
  });

  it('the intraday CRITICAL direct-assign sweep does not assign a component-blocked ticket either', async () => {
    // Both tickets are CRITICAL, OPEN and UNASSIGNED, so both are exactly what this sweep exists to
    // push out fast. The blocked one is the case where speed is the problem: a direct assignment lands
    // on the SE's Day Plan for a job whose part is still on order, and the fastest possible dispatch is
    // a wasted trip. `assignCriticalForZone` had no cycle filter at all — the same blind spot as the
    // morning pool, reached by a different query.
    const outcome = await intraday.assignCriticalForZone(zoneId, NOW);

    const assignedTickets = await prisma.intradayInsertion.findMany({
      where: { ticketId: { in: ticketIds } },
      select: { ticketId: true },
    });
    const touched = assignedTickets.map((i) => i.ticketId);

    expect(touched).toContain(tOpen);
    expect(touched).not.toContain(tBlocked);

    // `escalated` means "no capacity-eligible candidate" — the ZM Grouped Critical Queue picks those
    // up. A blocked ticket must not land there either: it is not an Ops coverage problem to be solved
    // by finding somebody, it is work that is correctly waiting. Excluded from the read, so neither
    // counter moves for it.
    expect(outcome.assigned).toBe(1);
    expect(outcome.escalated).toBe(0);
  });

  it('AC-3 — the run ledger reports the withheld work instead of swallowing it', async () => {
    // The exclusion must not be the kind of fix that makes a number quietly smaller. Before this
    // slice a blocked ticket was dispatched and therefore visible as a recommendation; excluding it
    // without counting it would move it from "on the plan" to nowhere at all, which is strictly less
    // honest than the bug — the plant still has work, and nothing on the run would say so.
    const summary = await rec.runForZone(zoneId, { now: NOW, dryRun: true, targetDate: NOW });
    expect(summary.componentBlockedWithheld).toBe(1);

    // Kept apart from the two figures beside it, because the three call for different people. This
    // one is neither an Ops coverage gap (`unassignable` — the engine looked and found nobody) nor a
    // policy hold on an ageing device (`withheldBelowThreshold`); it is the warehouse's clock.
    expect(summary.unassignable).toBe(0);
    expect(summary.withheldBelowThreshold).toBe(0);

    const outcome = await runs.runForActiveZones(NOW, { zoneId, trigger: 'MANUAL' });
    expect(outcome.result).toBe('RAN');

    const zoneRow = await prisma.dispatchRunZone.findFirstOrThrow({
      where: { zoneId },
      orderBy: { id: 'desc' },
    });
    expect(zoneRow.componentBlockedWithheld).toBe(1);

    const run = await prisma.dispatchRun.findUniqueOrThrow({ where: { runId: zoneRow.runId } });
    // The run total is the sum of its zone cards, the property every column beside it already holds.
    expect(run.componentBlockedWithheld).toBe(1);
  });

  it('a run that predates the counter reads NULL, not zero', async () => {
    // #242's honesty clause, and it applies here for the same reason: this work has been dispatched
    // all along rather than withheld, so writing 0 onto a historical run would assert a measurement
    // nobody took. NULL says "not recorded" and keeps the column from backdating a claim.
    const columns = await prisma.$queryRaw<{ is_nullable: string }[]>`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'dispatch_runs' AND column_name = 'component_blocked_withheld'`;
    expect(columns[0]?.is_nullable).toBe('YES');
  });

  it('AC-2/AC-4 — the part arrives, the cycle returns to OPEN, and the ticket re-dispatches', async () => {
    // The round trip this exclusion must not break. A component-blocked ticket sits UNASSIGNED for as
    // long as the part is on order — including through #179's bulk unassign, which sweeps blocked
    // tickets deliberately — and comes back the moment the cycle reopens. That is not an edge case:
    // `confirmResubmit`'s floating-SE RETURN_TO_POOL is the *normal* way blocked work resumes.
    const before = await rec.runForZone(zoneId, { now: NOW, dryRun: true, targetDate: NOW });
    expect((before.projection?.decisions ?? []).map((d) => d.ticketId)).not.toContain(tBlocked);
    expect(before.componentBlockedWithheld).toBe(1);

    // The part lands. Only the cycle STATE moves — `sla_paused` and its reason are left standing on
    // purpose, which is what makes this an assertion rather than a restatement: a predicate keyed on
    // the pause flag, on the pause reason, or on "has a component request" still reads this ticket as
    // blocked and would strand it here forever. Only one keyed on the live state lets it through.
    await prisma.failureCycle.updateMany({
      where: { ticket: { ticketId: tBlocked } },
      data: { state: 'OPEN' },
    });

    const after = await rec.runForZone(zoneId, { now: NOW, dryRun: true, targetDate: NOW });
    expect((after.projection?.decisions ?? []).map((d) => d.ticketId)).toContain(tBlocked);

    // And the figure follows the work rather than lagging it: nothing is being held back now.
    expect(after.componentBlockedWithheld).toBe(0);
  });
});
