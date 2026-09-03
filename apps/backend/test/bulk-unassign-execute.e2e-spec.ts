import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import { NotificationService } from '../src/notifications/notification.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { BulkUnassignService } from '../src/scheduling/bulk-unassign.service';
import { PrismaSoftStateConflictPort } from '../src/soft-state/soft-state-conflict.adapter';
import { REMOVAL_REASONS } from '../src/scheduling/removal-reason';
import { NOTIFY_EVENT_TYPE, drainRows } from '../src/scheduling/day-plan-notification-outbox';
import type { NotifyInput } from '../src/notifications/notification.service';
import {
  EnqueueFailed,
  failingNotifyEnqueue,
  inertDayPlanNotifier,
  throwingNotifications,
} from './fixtures/outbox-crash-injection';

/**
 * #179 Slice 1 — execute(). Design settled in
 * `.scratch/fsm-platform-v1/issues/179-oh-bulk-unassign-rebalance.md` — do not re-derive it.
 * Rebuilt genuinely test-first after a 2026-07-29 process correction (see the slice report):
 * advisory lock → happy path → audit contract → re-dispatch → Pan-India token, in that order.
 */
const NS = Date.now();
const OH_ACTOR = { userId: '33333333-3333-3333-3333-333333333333', role: 'OPERATIONS_HEAD' };
const NOW = new Date('2026-07-29T09:30:00Z');
const DAY = new Date(Date.UTC(2026, 6, 29));

describe('BulkUnassignService.execute (#179 slice 1)', () => {
  let prisma: PrismaService;
  let svc: BulkUnassignService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new BulkUnassignService(
      prisma,
      new AuditService(prisma),
      new NotificationService(prisma),
      new PrismaSoftStateConflictPort(prisma),
    );
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  /** One fully self-contained zone/company/plant/SE fixture, torn down at the end of the test. */
  const makeFixture = async (label: string) => {
    const zoneId = (await prisma.zone.create({ data: { name: `Z-exec-${label}-` + NS } })).zoneId;
    const companyId = (await prisma.company.create({ data: { name: `Co-exec-${label}-` + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    const plantId = (await prisma.plant.create({ data: { name: `P-exec-${label}-` + NS, zoneId } })).plantId;
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({ data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@exec.test`, zoneId } });
    await prisma.engineerMaster.create({ data: { engineerId: u.userId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
    await prisma.seCoverage.create({ data: { seId: u.userId, plantId, coverageType: 'DEDICATED' } });

    const ticketIds: string[] = [];
    const deviceIds: string[] = [];
    const cycleIds: string[] = [];

    const makeTicket = async (opts: {
      workType?: 'TROUBLESHOOT' | 'INSTALL' | 'RECOVERY';
      status?: string;
      assignmentState?: 'FORMALLY_ASSIGNED' | 'UNASSIGNED';
      cycleState?: 'OPEN' | 'WAITING_COMPONENT';
      deferredUntil?: Date;
    }): Promise<string> => {
      const deviceId = String(9_788_000_000 + (NS % 100_000) * 100 + deviceIds.length);
      deviceIds.push(deviceId);
      await prisma.device.create({ data: { deviceId } });
      let failureCycleId: string | undefined;
      const workType = opts.workType ?? 'TROUBLESHOOT';
      if (workType === 'TROUBLESHOOT') {
        const cycle = await prisma.failureCycle.create({ data: { deviceId, state: opts.cycleState ?? 'OPEN', openedAt: NOW } });
        cycleIds.push(cycle.cycleId);
        failureCycleId = cycle.cycleId;
      }
      const ticket = await prisma.ticket.create({
        data: {
          workType,
          status: opts.status ?? 'OPEN',
          failureCycleId,
          deviceId,
          plantId,
          companyId,
          companyTier: 'GOLD',
          assignmentState: opts.assignmentState ?? 'FORMALLY_ASSIGNED',
          deferredUntil: opts.deferredUntil ?? null,
          lastStateChangedAt: NOW,
        },
      });
      ticketIds.push(ticket.ticketId);
      return ticket.ticketId;
    };

    /** `on` defaults to today; pass an earlier date to build a stale-dated (past) live schedule. */
    const placeOnLiveBatch = async (ticketId: string, on: Date = DAY): Promise<{ scheduleId: bigint; batchId: bigint }> => {
      let schedule = await prisma.workSchedule.findFirst({ where: { zoneId, seId: u.userId, dateFrom: on, status: 'ACTIVE' } });
      if (!schedule) {
        schedule = await prisma.workSchedule.create({
          data: { seId: u.userId, zoneId, dateFrom: on, dateTo: on, status: 'ACTIVE', source: 'SYSTEM_GENERATED', dispatchedAt: NOW },
        });
      }
      const batch = await prisma.plantBatchAssignment.create({
        data: { scheduleId: schedule.scheduleId, plantId, seId: u.userId, status: 'AUTO_ASSIGNED', stopSequence: 1 },
      });
      await prisma.batchAssignmentTicket.create({ data: { batchId: batch.batchId, ticketId, sortOrder: 1 } });
      return { scheduleId: schedule.scheduleId, batchId: batch.batchId };
    };

    const teardown = async () => {
      await prisma.notificationDelivery.deleteMany({ where: { notification: { entityId: zoneId.toString() } } });
      await prisma.notification.deleteMany({ where: { entityId: zoneId.toString() } });
      await prisma.auditLog.deleteMany({ where: { actingZone: zoneId } });
      await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
      await prisma.softState.deleteMany({ where: { ticketId: { in: ticketIds } } });
      await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
      await prisma.sePlanner.deleteMany({ where: { plantId } });
      const schedules = await prisma.workSchedule.findMany({ where: { zoneId }, select: { scheduleId: true } });
      const batches = await prisma.plantBatchAssignment.findMany({ where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } }, select: { batchId: true } });
      await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
      await prisma.plantBatchAssignment.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
      await prisma.workSchedule.deleteMany({ where: { zoneId } });
      await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
      await prisma.failureCycle.deleteMany({ where: { cycleId: { in: cycleIds } } });
      await prisma.seCoverage.deleteMany({ where: { plantId } });
      await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
      await prisma.engineerMaster.deleteMany({ where: { engineerId: u.userId } });
      await prisma.user.deleteMany({ where: { userId: u.userId } });
      await prisma.plant.deleteMany({ where: { plantId } });
      await prisma.company.deleteMany({ where: { companyId } });
      await prisma.zone.deleteMany({ where: { zoneId } });
    };

    return { zoneId, companyId, plantId, seId: u.userId, makeTicket, placeOnLiveBatch, teardown };
  };

  it('skips a zone whose advisory lock is already held, reports it, and touches nothing', async () => {
    const f = await makeFixture('lock');
    try {
      const eligible = await f.makeTicket({});
      await f.placeOnLiveBatch(eligible);

      // Hold the exact lock key dispatch/bulk-unassign use, on a separate raw connection, for the
      // duration of the execute() call — simulating a concurrent dispatch run mid-zone.
      const holder = new PrismaService();
      await holder.onModuleInit();
      try {
        await holder.$transaction(async (tx) => {
          const locked = await tx.$queryRaw<{ locked: boolean }[]>`
            SELECT pg_try_advisory_xact_lock(hashtext(${'dispatch_zone_' + f.zoneId.toString()})) AS locked`;
          expect(locked[0]?.locked).toBe(true); // sanity: we actually hold it

          const outcome = await svc.execute({ scope: 'ZONE', zoneId: f.zoneId, reasonCode: 'ROUTINE_REBALANCE' }, OH_ACTOR, NOW);
          if (outcome.result !== 'OK') throw new Error(`expected OK, got ${outcome.result}`);
          const zoneResult = outcome.zones.find((z) => z.zoneId === f.zoneId.toString());
          expect(zoneResult?.skipped).toBe(true);
          expect(zoneResult?.skipReason).toBe('LOCK_CONTENDED');
          expect(zoneResult?.ticketsUnassigned).toBe(0);
        });
      } finally {
        await holder.onModuleDestroy();
      }

      // Nothing was touched: the ticket is still assigned and its batch row still live.
      const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: eligible } });
      expect(ticket.assignmentState).toBe('FORMALLY_ASSIGNED');
      const bat = await prisma.batchAssignmentTicket.findFirstOrThrow({ where: { ticketId: eligible } });
      expect(bat.removedAt).toBeNull();

      // The skip is still reported in the audit trail — Pan-India history stays legible per zone.
      const auditRows = await prisma.auditLog.findMany({ where: { actingZone: f.zoneId, action: 'BULK_UNASSIGN_ZONE' } });
      expect(auditRows).toHaveLength(1);
      const meta = auditRows[0].metadata as Record<string, unknown>;
      expect(meta.skipped).toBe(true);
      expect(meta.skipReason).toBe('LOCK_CONTENDED');
    } finally {
      await f.teardown();
    }
  });

  /**
   * #262 AC-6 — a bulk-unassign must not interleave with a zone dispatch.
   *
   * The advisory lock was enough while dispatch was ONE transaction for the whole zone: the lock was
   * held for the entire write, so a rebalance either got there first or waited. #262 splits that into
   * one transaction per SE, and the lock — `pg_advisory_xact_lock` — is released at each SE's commit.
   * The gaps between SE transactions are therefore unguarded, and a bulk-unassign landing in one
   * produces a half-rebalanced zone: SE1 dispatched → unassigned → SE2 dispatched fresh.
   *
   * What spans the whole dispatch is #259's zone claim, which is RUNNING from admission to completion.
   * So the rebalance has to respect that claim, not just the lock.
   */
  it('#262: skips a zone a live dispatch run has claimed, even between its per-SE transactions', async () => {
    const f = await makeFixture('claimed');
    try {
      const eligible = await f.makeTicket({});
      await f.placeOnLiveBatch(eligible, NOW);

      // A dispatch run holding the zone — the #259 claim, exactly as `runForActiveZones` opens it. No
      // advisory lock is held here at all: between two per-SE transactions there would be none, which
      // is the whole point.
      const run = await prisma.dispatchRun.create({
        data: { trigger: 'CRON', status: 'RUNNING', startedAt: NOW, heartbeatAt: new Date(), configSnapshot: {} },
      });
      await prisma.dispatchRunZone.create({
        data: { runId: run.runId, zoneId: f.zoneId, status: 'RUNNING', startedAt: NOW },
      });

      try {
        const outcome = await svc.execute({ scope: 'ZONE', zoneId: f.zoneId, reasonCode: 'ROUTINE_REBALANCE' }, OH_ACTOR, NOW);
        if (outcome.result !== 'OK') throw new Error(`expected OK, got ${outcome.result}`);
        const zoneResult = outcome.zones.find((z) => z.zoneId === f.zoneId.toString());
        expect(zoneResult?.skipped).toBe(true);
        expect(zoneResult?.skipReason).toBe('DISPATCH_IN_PROGRESS');
        expect(zoneResult?.ticketsUnassigned).toBe(0);

        // Nothing was touched — the dispatch keeps every SE it admitted.
        const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: eligible } });
        expect(ticket.assignmentState).toBe('FORMALLY_ASSIGNED');
      } finally {
        await prisma.dispatchRunZone.deleteMany({ where: { runId: run.runId } });
        await prisma.dispatchRun.delete({ where: { runId: run.runId } });
      }
    } finally {
      await f.teardown();
    }
  });

  /** A claim that is finished holds nothing: the zone is free the moment the dispatch lets go. */
  it('#262: a finished claim does not block a rebalance', async () => {
    const f = await makeFixture('claim-done');
    try {
      const eligible = await f.makeTicket({});
      await f.placeOnLiveBatch(eligible, NOW);

      const run = await prisma.dispatchRun.create({
        data: { trigger: 'CRON', status: 'SUCCESS', startedAt: NOW, finishedAt: NOW, configSnapshot: {} },
      });
      await prisma.dispatchRunZone.create({
        data: { runId: run.runId, zoneId: f.zoneId, status: 'DONE', startedAt: NOW, finishedAt: NOW },
      });

      try {
        const outcome = await svc.execute({ scope: 'ZONE', zoneId: f.zoneId, reasonCode: 'ROUTINE_REBALANCE' }, OH_ACTOR, NOW);
        if (outcome.result !== 'OK') throw new Error(`expected OK, got ${outcome.result}`);
        const zoneResult = outcome.zones.find((z) => z.zoneId === f.zoneId.toString());
        expect(zoneResult?.skipped).toBe(false);
        expect(zoneResult?.ticketsUnassigned).toBe(1);
      } finally {
        await prisma.dispatchRunZone.deleteMany({ where: { runId: run.runId } });
        await prisma.dispatchRun.delete({ where: { runId: run.runId } });
      }
    } finally {
      await f.teardown();
    }
  });

  it('unassigns eligible/on-site/component-blocked, excludes the rest, and writes the ticket/event/schedule contract', async () => {
    const f = await makeFixture('happy');
    try {
      const eligible = await f.makeTicket({});
      await f.placeOnLiveBatch(eligible);

      const onSite = await f.makeTicket({});
      const { scheduleId } = await f.placeOnLiveBatch(onSite);
      await prisma.softState.create({ data: { ticketId: onSite, seId: f.seId, type: 'ON_SITE' } });

      const blocked = await f.makeTicket({ cycleState: 'WAITING_COMPONENT' });
      await f.placeOnLiveBatch(blocked);

      const closed = await f.makeTicket({ status: 'CLOSED' });
      await f.placeOnLiveBatch(closed);

      const install = await f.makeTicket({ workType: 'INSTALL', status: 'REQUESTED' });
      await f.placeOnLiveBatch(install);

      const deferred = await f.makeTicket({ assignmentState: 'UNASSIGNED', deferredUntil: new Date(Date.UTC(2026, 6, 30)) });

      const outcome = await svc.execute({ scope: 'ZONE', zoneId: f.zoneId, reasonCode: 'ROUTINE_REBALANCE' }, OH_ACTOR, NOW);
      if (outcome.result !== 'OK') throw new Error(`expected OK, got ${outcome.result}`);
      const zoneResult = outcome.zones.find((z) => z.zoneId === f.zoneId.toString());
      expect(zoneResult?.skipped).toBe(false);
      expect(zoneResult?.ticketsUnassigned).toBe(3); // eligible + onSite + blocked

      // In-scope tickets are unassigned; the three excluded classes are untouched.
      const touched = await prisma.ticket.findMany({ where: { ticketId: { in: [eligible, onSite, blocked] } } });
      expect(touched.every((t) => t.assignmentState === 'UNASSIGNED')).toBe(true);

      const untouchedClosed = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: closed } });
      expect(untouchedClosed.assignmentState).toBe('FORMALLY_ASSIGNED');
      const untouchedInstall = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: install } });
      expect(untouchedInstall.assignmentState).toBe('FORMALLY_ASSIGNED');
      const untouchedDeferred = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: deferred } });
      expect(untouchedDeferred.assignmentState).toBe('UNASSIGNED');
      expect(untouchedDeferred.deferredUntil).not.toBeNull(); // deferred_until neither set nor cleared here

      // Live batch rows for the three in-scope tickets are stamped, not deleted.
      const stampedRows = await prisma.batchAssignmentTicket.findMany({ where: { ticketId: { in: [eligible, onSite, blocked] } } });
      expect(stampedRows).toHaveLength(3);
      expect(stampedRows.every((r) => r.removedAt !== null && r.removedBy === OH_ACTOR.userId)).toBe(true);
      // #241 — every removed row carries its cause; a bulk clear is its own, distinct from a per-ticket
      // withdrawal even though both are human-actioned.
      expect(stampedRows.every((r) => r.removalReason === REMOVAL_REASONS.BULK_UNASSIGNED)).toBe(true);

      // Excluded classes' batch rows are still live.
      const excludedRows = await prisma.batchAssignmentTicket.findMany({ where: { ticketId: { in: [closed, install] } } });
      expect(excludedRows.every((r) => r.removedAt === null)).toBe(true);

      // ticket_events: one BULK_UNASSIGNED row per touched ticket, same-state OPEN->OPEN.
      const events = await prisma.ticketEvent.findMany({ where: { ticketId: { in: [eligible, onSite, blocked] }, reasonCode: 'BULK_UNASSIGNED' } });
      expect(events).toHaveLength(3);
      expect(events.every((e) => e.fromState === 'OPEN' && e.toState === 'OPEN' && e.actorId === OH_ACTOR.userId)).toBe(true);

      // Schedule stays ACTIVE (D3) with provenance stamped — never OVERRIDDEN.
      const sched = await prisma.workSchedule.findUniqueOrThrow({ where: { scheduleId } });
      expect(sched.status).toBe('ACTIVE');
      expect(sched.lastOverriddenBy).toBe(OH_ACTOR.userId);
      expect(sched.lastOverriddenAt).not.toBeNull();

      // Batch (PlantBatchAssignment) status is untouched — only the ticket row inside it is stamped.
      const batches = await prisma.plantBatchAssignment.findMany({ where: { scheduleId } });
      expect(batches.every((b) => b.status === 'AUTO_ASSIGNED')).toBe(true);
    } finally {
      await f.teardown();
    }
  });

  // D1 REVERSED 2026-07-29 (operator): the sweep covers every LIVE schedule regardless of date, not
  // just today's. A ticket sitting on a week-old ACTIVE schedule is exactly the case that motivated
  // the reversal — it reads as "assigned" on every surface while nobody is working it.
  it('unassigns work on a stale-dated (past) live schedule, not just today', async () => {
    const f = await makeFixture('stale-date');
    const YESTERDAY = new Date(Date.UTC(2026, 6, 28));
    const LAST_WEEK = new Date(Date.UTC(2026, 6, 21));
    try {
      const todayTicket = await f.makeTicket({});
      await f.placeOnLiveBatch(todayTicket);

      const yesterdayTicket = await f.makeTicket({});
      const { scheduleId: staleScheduleId } = await f.placeOnLiveBatch(yesterdayTicket, YESTERDAY);

      const lastWeekTicket = await f.makeTicket({});
      await f.placeOnLiveBatch(lastWeekTicket, LAST_WEEK);

      const outcome = await svc.execute({ scope: 'ZONE', zoneId: f.zoneId, reasonCode: 'FULL_REBALANCE' }, OH_ACTOR, NOW);
      if (outcome.result !== 'OK') throw new Error(`expected OK, got ${outcome.result}`);
      const zoneResult = outcome.zones.find((z) => z.zoneId === f.zoneId.toString());
      expect(zoneResult?.ticketsUnassigned).toBe(3); // today + yesterday + last week

      const all = await prisma.ticket.findMany({ where: { ticketId: { in: [todayTicket, yesterdayTicket, lastWeekTicket] } } });
      expect(all.every((t) => t.assignmentState === 'UNASSIGNED')).toBe(true);

      const rows = await prisma.batchAssignmentTicket.findMany({
        where: { ticketId: { in: [todayTicket, yesterdayTicket, lastWeekTicket] } },
      });
      expect(rows.every((r) => r.removedAt !== null)).toBe(true);

      // The stale schedule is stamped for provenance and stays ACTIVE (D3 holds regardless of date).
      const staleSched = await prisma.workSchedule.findUniqueOrThrow({ where: { scheduleId: staleScheduleId } });
      expect(staleSched.status).toBe('ACTIVE');
      expect(staleSched.lastOverriddenBy).toBe(OH_ACTOR.userId);

      // The audit row states the date scope explicitly, so history stays interpretable across the
      // D1 reversal (rows written before it were implicitly today-only).
      const auditRows = await prisma.auditLog.findMany({ where: { actingZone: f.zoneId, action: 'BULK_UNASSIGN_ZONE' } });
      expect(auditRows).toHaveLength(1);
      expect((auditRows[0].metadata as Record<string, unknown>).dateScope).toBe('ALL_LIVE');
    } finally {
      await f.teardown();
    }
  });

  it('writes one BULK_UNASSIGN_ZONE audit row with the full metadata contract, and one notification per affected SE', async () => {
    const f = await makeFixture('audit');
    try {
      const eligible = await f.makeTicket({});
      await f.placeOnLiveBatch(eligible);
      const blocked = await f.makeTicket({ cycleState: 'WAITING_COMPONENT' });
      await f.placeOnLiveBatch(blocked);
      const closed = await f.makeTicket({ status: 'CLOSED' });
      await f.placeOnLiveBatch(closed);

      const outcome = await svc.execute({ scope: 'ZONE', zoneId: f.zoneId, reasonCode: 'ROUTINE_REBALANCE' }, OH_ACTOR, NOW);
      if (outcome.result !== 'OK') throw new Error(`expected OK, got ${outcome.result}`);

      const auditRows = await prisma.auditLog.findMany({ where: { actingZone: f.zoneId, action: 'BULK_UNASSIGN_ZONE' } });
      expect(auditRows).toHaveLength(1);
      const meta = auditRows[0].metadata as Record<string, unknown>;
      expect(meta.operationId).toBe(outcome.operationId);
      expect(meta.scope).toBe('ZONE');
      expect(meta.reasonCode).toBe('ROUTINE_REBALANCE');
      expect(meta.counts).toEqual({
        eligible: 1,
        onSite: 0,
        componentBlocked: 1,
        closedExcluded: 1,
        installRecoveryExcluded: 0,
        deferredExcluded: 0,
      });
      expect(meta.buildFingerprint).toEqual(expect.any(String));
      expect(meta.buildVersion).toEqual(expect.any(String));
      expect(auditRows[0].actorId).toBe(OH_ACTOR.userId);

      // Exactly one DAY_PLAN_REBALANCED notification for the one affected SE (2 tickets, 1 SE).
      const notifications = await prisma.notification.findMany({ where: { recipientUserId: f.seId, type: 'DAY_PLAN_REBALANCED' } });
      expect(notifications).toHaveLength(1);
      expect(notifications[0].metadata as Record<string, unknown>).toMatchObject({ operationId: outcome.operationId });
    } finally {
      await f.teardown();
    }
  });

  it('re-dispatch after execute reuses the same schedule and fully frees capacity (APPEND-onto-empty)', async () => {
    // Real dispatch services — proves the mechanism against RecommenderService/BatchAssignmentService,
    // not just against the assertions this feature's own code makes about itself.
    const rec = new RecommenderService(prisma, new CandidateSelectionService(prisma));
    const dispatch = new BatchAssignmentService(prisma);

    const zoneId = (await prisma.zone.create({ data: { name: 'Z-exec-redispatch-' + NS } })).zoneId;
    const companyId = (await prisma.company.create({ data: { name: 'Co-exec-redispatch-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    const plantId = (await prisma.plant.create({ data: { name: 'P-exec-redispatch-' + NS, zoneId } })).plantId;
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({ data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@redispatch.test`, zoneId } });
    // Capacity discriminator: 10 capacity / 6 tickets. If the unassign left committedDayLoad stale,
    // re-dispatch could recommend at most 4 (10 - 6 prior). Recommending 6 proves the load was freed.
    await prisma.engineerMaster.create({ data: { engineerId: u.userId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
    await prisma.seCoverage.create({ data: { seId: u.userId, plantId, coverageType: 'DEDICATED' } });

    const ticketIds: string[] = [];
    const deviceIds: string[] = [];
    const runIds: bigint[] = [];

    const makeRecommendableTicket = async (gpsAgeMin: number): Promise<string> => {
      const deviceId = String(9_799_000_000 + (NS % 100_000) * 100 + deviceIds.length);
      deviceIds.push(deviceId);
      await prisma.device.create({ data: { deviceId } });
      await prisma.deviceState.create({
        data: {
          deviceId, isInactive: true, slaBucket: 'CRITICAL', eligibleForUptime: true, hasOpenFailureCycle: true,
          latestGpsDatetime: new Date(NOW.getTime() - gpsAgeMin * 60_000), plantId, companyId, computedAt: NOW,
        },
      });
      const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
      const ticket = await prisma.ticket.create({
        data: { workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: cycle.cycleId, deviceId, plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: NOW },
      });
      ticketIds.push(ticket.ticketId);
      return ticket.ticketId;
    };

    try {
      for (const age of [300, 240, 180, 120, 90, 60]) await makeRecommendableTicket(age);
      const run1 = await prisma.dispatchRun.create({ data: { trigger: 'MANUAL', startedAt: NOW, configSnapshot: {}, status: 'RUNNING' } });
      runIds.push(run1.runId);
      const rec1 = await rec.runForZone(zoneId, { now: NOW, runId: run1.runId });
      const out1 = await dispatch.dispatchForZone(zoneId, { dateFrom: DAY, dateTo: DAY, now: NOW, runId: run1.runId });
      await prisma.dispatchRun.update({ where: { runId: run1.runId }, data: { status: 'SUCCESS', finishedAt: NOW } });
      expect(rec1.recommended).toBe(6);
      expect(out1.tickets).toBe(6);

      const scheduleBefore = await prisma.workSchedule.findFirstOrThrow({ where: { zoneId, seId: u.userId } });
      const maxStopBefore = (await prisma.plantBatchAssignment.aggregate({ where: { scheduleId: scheduleBefore.scheduleId }, _max: { stopSequence: true } }))._max.stopSequence!;

      const midday = new Date('2026-07-29T09:30:00Z');
      const outcome = await svc.execute({ scope: 'ZONE', zoneId, reasonCode: 'ROUTINE_REBALANCE' }, OH_ACTOR, midday);
      if (outcome.result !== 'OK') throw new Error(`expected OK, got ${outcome.result}`);
      const zoneResult = outcome.zones.find((z) => z.zoneId === zoneId.toString());
      expect(zoneResult?.ticketsUnassigned).toBe(6);

      // Same schedule stays ACTIVE, now an empty-but-live shell.
      const shell = await prisma.workSchedule.findUniqueOrThrow({ where: { scheduleId: scheduleBefore.scheduleId } });
      expect(shell.status).toBe('ACTIVE');

      const run2 = await prisma.dispatchRun.create({ data: { trigger: 'MANUAL', startedAt: midday, configSnapshot: {}, status: 'RUNNING' } });
      runIds.push(run2.runId);
      const rec2 = await rec.runForZone(zoneId, { now: midday, runId: run2.runId });
      const out2 = await dispatch.dispatchForZone(zoneId, { dateFrom: DAY, dateTo: DAY, now: midday, runId: run2.runId });
      await prisma.dispatchRun.update({ where: { runId: run2.runId }, data: { status: 'SUCCESS', finishedAt: midday } });

      expect(rec2.recommended).toBe(6); // capacity fully freed — not capped at 10-6=4
      expect(out2.tickets).toBe(6);
      expect(out2.skipReason).toBeUndefined();

      // APPEND-onto-empty: same schedule reused, no P2002, no second (se, zone, day) plan.
      const schedulesAfter = await prisma.workSchedule.findMany({ where: { zoneId, seId: u.userId } });
      expect(schedulesAfter).toHaveLength(1);
      expect(schedulesAfter[0].scheduleId).toBe(scheduleBefore.scheduleId);
      expect(schedulesAfter[0].status).toBe('ACTIVE');

      const tix = await prisma.ticket.findMany({ where: { ticketId: { in: ticketIds } } });
      expect(tix.every((t) => t.assignmentState === 'FORMALLY_ASSIGNED')).toBe(true);
      const live = await prisma.batchAssignmentTicket.findMany({ where: { ticketId: { in: ticketIds }, removedAt: null } });
      expect(live).toHaveLength(6);

      // Stop numbering continues over the emptied stop (#127 artifact, stated in the issue as
      // accepted, not fixed here).
      const freshBatches = await prisma.plantBatchAssignment.findMany({ where: { scheduleId: scheduleBefore.scheduleId, runId: run2.runId } });
      expect(freshBatches[0].stopSequence).toBe(maxStopBefore + 1);
    } finally {
      await prisma.dispatchDecisionTrace.deleteMany({ where: { ticketId: { in: ticketIds } } });
      await prisma.auditLog.deleteMany({ where: { actingZone: zoneId } });
      const schedules = await prisma.workSchedule.findMany({ where: { zoneId }, select: { scheduleId: true } });
      const batches = await prisma.plantBatchAssignment.findMany({ where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } }, select: { batchId: true } });
      await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
      await prisma.plantBatchAssignment.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
      await prisma.workSchedule.deleteMany({ where: { zoneId } });
      await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
      await prisma.dispatchRunZone.deleteMany({ where: { runId: { in: runIds } } });
      await prisma.dispatchRun.deleteMany({ where: { runId: { in: runIds } } });
      await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
      await prisma.notification.deleteMany({ where: { entityId: zoneId.toString() } });
      await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
      await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
      await prisma.seCoverage.deleteMany({ where: { plantId } });
      await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
      await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
      await prisma.engineerMaster.deleteMany({ where: { engineerId: u.userId } });
      await prisma.user.deleteMany({ where: { userId: u.userId } });
      await prisma.plant.deleteMany({ where: { plantId } });
      await prisma.company.deleteMany({ where: { companyId } });
      await prisma.zone.deleteMany({ where: { zoneId } });
    }
  });

  // Split into three isolated tests (own fixture each) rather than one long scenario: a PAN_INDIA
  // execute sweeps every active zone in the shared `fsm_test` DB, so a RED run of the "missing
  // token" guard (before it exists) genuinely executes for real — isolating it to its own single,
  // known, disposable ticket keeps that one unguarded RED run's blast radius contained instead of
  // contaminating the stale/fresh sub-cases' assertions in the same test.

  it('PAN_INDIA execute without a preview token is refused, and touches nothing', async () => {
    const f = await makeFixture('token-missing');
    try {
      const eligible = await f.makeTicket({});
      await f.placeOnLiveBatch(eligible);

      const missing = await svc.execute({ scope: 'PAN_INDIA', reasonCode: 'ROUTINE_REBALANCE' }, OH_ACTOR, NOW);
      expect(missing.result).toBe('TOKEN_REQUIRED');

      const untouched = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: eligible } });
      expect(untouched.assignmentState).toBe('FORMALLY_ASSIGNED');
    } finally {
      await f.teardown();
    }
  });

  it('PAN_INDIA execute with a stale preview token is refused, with fresh counts, and touches nothing', async () => {
    const f = await makeFixture('token-stale');
    try {
      const eligible = await f.makeTicket({});
      await f.placeOnLiveBatch(eligible);

      const staleToken = (await svc.preview({ scope: 'PAN_INDIA', reasonCode: 'ROUTINE_REBALANCE' }, NOW)).previewToken;
      const secondEligible = await f.makeTicket({});
      await f.placeOnLiveBatch(secondEligible);

      const stale = await svc.execute({ scope: 'PAN_INDIA', reasonCode: 'ROUTINE_REBALANCE', previewToken: staleToken }, OH_ACTOR, NOW);
      expect(stale.result).toBe('TOKEN_STALE');
      if (stale.result === 'TOKEN_STALE') {
        expect(stale.freshPreview.zones.find((z) => z.zoneId === f.zoneId.toString())?.counts.eligible).toBe(2);
      }

      const stillUntouched = await prisma.ticket.findMany({ where: { ticketId: { in: [eligible, secondEligible] } } });
      expect(stillUntouched.every((t) => t.assignmentState === 'FORMALLY_ASSIGNED')).toBe(true);
    } finally {
      await f.teardown();
    }
  });

  it('PAN_INDIA execute with a fresh preview token succeeds and reuses its operationId', async () => {
    const f = await makeFixture('token-fresh');
    try {
      const eligible = await f.makeTicket({});
      await f.placeOnLiveBatch(eligible);

      const freshToken = await svc.preview({ scope: 'PAN_INDIA', reasonCode: 'ROUTINE_REBALANCE' }, NOW);
      const outcome = await svc.execute({ scope: 'PAN_INDIA', reasonCode: 'ROUTINE_REBALANCE', previewToken: freshToken.previewToken }, OH_ACTOR, NOW);
      expect(outcome.result).toBe('OK');
      if (outcome.result === 'OK') {
        expect(outcome.operationId).toBe(freshToken.operationId);
        const zoneResult = outcome.zones.find((z) => z.zoneId === f.zoneId.toString());
        expect(zoneResult?.ticketsUnassigned).toBe(1);
      }

      const touched = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: eligible } });
      expect(touched.assignmentState).toBe('UNASSIGNED');

      // The audit row must record the ACTUAL scope of the operation ('PAN_INDIA'), not the literal
      // 'ZONE' every prior test happened to pass with by coincidence (all of them used scope: 'ZONE').
      const auditRows = await prisma.auditLog.findMany({ where: { actingZone: f.zoneId, action: 'BULK_UNASSIGN_ZONE' } });
      expect(auditRows).toHaveLength(1);
      expect((auditRows[0].metadata as Record<string, unknown>).scope).toBe('PAN_INDIA');
    } finally {
      await f.teardown();
    }
  });

  /**
   * #338 — the rebalance's own notice is durable.
   *
   * `DAY_PLAN_REBALANCED` fired post-commit under a comment that got the posture exactly right and
   * the mechanism half right: the push must not happen for a rolled-back rebalance, which is true —
   * but with nothing durable behind it, a crash between the commit and the push left engineers whose
   * day was emptied with no idea it had been, and a *throw* aborted the Pan-India loop partway
   * through, leaving the remaining zones unrebalanced for a reason that has nothing to do with them.
   *
   * The notice now commits inside the same transaction as the unassign, beside the audit row that
   * already lived there. One row per affected engineer, which is what the loop always wrote.
   */
  describe('#338 — the rebalance notice is written in the unassign transaction', () => {
    const svcOn = (client: PrismaService, notifications: NotificationService = new NotificationService(client)) =>
      new BulkUnassignService(
        client,
        new AuditService(client),
        notifications,
        new PrismaSoftStateConflictPort(client),
      );

    const payloadOf = (row: { payload: unknown }): NotifyInput => (row.payload ?? {}) as unknown as NotifyInput;

    const noticesForZone = async (zoneId: bigint) => {
      const rows = await prisma.dayPlanNotificationOutbox.findMany({
        where: { eventType: NOTIFY_EVENT_TYPE },
        orderBy: { id: 'asc' },
      });
      return rows.filter((r) => payloadOf(r).entityId === zoneId.toString());
    };

    it('a notifier that throws leaves the rebalance committed and the notice retryable', async () => {
      const f = await makeFixture('outbox-durability');
      try {
        const eligible = await f.makeTicket({});
        await f.placeOnLiveBatch(eligible);

        // This used to reject: one failed push aborted the operation with the zone already unassigned.
        const outcome = await svcOn(prisma, throwingNotifications()).execute(
          { scope: 'ZONE', zoneId: f.zoneId, reasonCode: 'ROUTINE_REBALANCE' },
          OH_ACTOR,
          NOW,
        );
        if (outcome.result !== 'OK') throw new Error(`expected OK, got ${outcome.result}`);
        expect(outcome.zones.find((z) => z.zoneId === f.zoneId.toString())?.ticketsUnassigned).toBe(1);

        const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: eligible } });
        expect(ticket.assignmentState).toBe('UNASSIGNED');

        const rows = await noticesForZone(f.zoneId);
        expect(rows).toHaveLength(1);
        const row = rows[0]!;
        expect(payloadOf(row).type).toBe('DAY_PLAN_REBALANCED');
        expect(payloadOf(row).recipients[0]!.userId).toBe(f.seId);
        expect(row.sentAt).toBeNull();
        expect(await prisma.notification.count({ where: { recipientUserId: f.seId, type: 'DAY_PLAN_REBALANCED' } })).toBe(0);

        await drainRows(prisma, inertDayPlanNotifier, [row.id], NOW, { notify: new NotificationService(prisma) });
        expect(await prisma.notification.count({ where: { recipientUserId: f.seId, type: 'DAY_PLAN_REBALANCED' } })).toBe(1);
        await drainRows(prisma, inertDayPlanNotifier, [row.id], NOW, { notify: new NotificationService(prisma) });
        expect(await prisma.notification.count({ where: { recipientUserId: f.seId, type: 'DAY_PLAN_REBALANCED' } })).toBe(1);

        await prisma.dayPlanNotificationOutbox.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
      } finally {
        await f.teardown();
      }
    });

    it('a failed enqueue rolls the zone back — no silent rebalance nobody was told about', async () => {
      const f = await makeFixture('outbox-atomicity');
      try {
        const eligible = await f.makeTicket({});
        const { batchId } = await f.placeOnLiveBatch(eligible);

        await expect(
          svcOn(failingNotifyEnqueue(prisma)).execute(
            { scope: 'ZONE', zoneId: f.zoneId, reasonCode: 'ROUTINE_REBALANCE' },
            OH_ACTOR,
            NOW,
          ),
        ).rejects.toThrow(EnqueueFailed);

        const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: eligible } });
        expect(ticket.assignmentState).toBe('FORMALLY_ASSIGNED');
        const bat = await prisma.batchAssignmentTicket.findFirstOrThrow({ where: { batchId, ticketId: eligible } });
        expect(bat.removedAt).toBeNull();
        // The audit row lives in the same transaction, so it goes too — the operation did not happen.
        expect(await prisma.auditLog.count({ where: { actingZone: f.zoneId, action: 'BULK_UNASSIGN_ZONE' } })).toBe(0);
        expect(await noticesForZone(f.zoneId)).toHaveLength(0);
      } finally {
        await f.teardown();
      }
    });
  });
});
