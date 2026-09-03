import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import type { ActorContext } from '../src/scheduling/override.service';
import { OverrideService } from '../src/scheduling/override.service';
import type { DayPlanDispatchedEvent, DayPlanNotifier, DayPlanOverriddenEvent } from '../src/scheduling/day-plan-notifier';
import { SpineDayPlanNotifier } from '../src/scheduling/day-plan-notifier';
import {
  DAY_PLAN_ACTION_PLANT_DEACTIVATED,
  drainRows,
  queueDayPlanOverridden,
} from '../src/scheduling/day-plan-notification-outbox';
import type { NotificationService, NotifyInput } from '../src/notifications/notification.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { DispatchRunService } from '../src/scheduling/dispatch-run.service';
import { AuditService } from '../src/audit/audit.service';

/**
 * #264 — the writer-side integration ACs: a notifier that throws must never make a successful
 * dispatch/override look failed (the misreport inversion this issue closes), and the outbox row it
 * left behind carries the error for the sweep to retry.
 */
class ThrowingNotifier implements DayPlanNotifier {
  dispatchedCalls: DayPlanDispatchedEvent[] = [];
  overriddenCalls: DayPlanOverriddenEvent[] = [];
  dayPlanDispatched(event: DayPlanDispatchedEvent): void {
    this.dispatchedCalls.push(event);
    throw new Error('notifier down');
  }
  dayPlanOverridden(event: DayPlanOverriddenEvent): void {
    this.overriddenCalls.push(event);
    throw new Error('notifier down');
  }
}

/** #345 — the same port, recording rather than throwing: a drain has to be able to succeed. */
class RecordingNotifier implements DayPlanNotifier {
  overriddenCalls: DayPlanOverriddenEvent[] = [];
  dayPlanDispatched(): void {}
  dayPlanOverridden(event: DayPlanOverriddenEvent): void {
    this.overriddenCalls.push(event);
  }
}

const NS = Date.now();
const NOW = new Date('2026-08-24T06:00:00Z');

describe('#264 — a notifier throw never fails the writer it belongs to', () => {
  let prisma: PrismaService;
  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let seId: string;
  let deviceId: string;
  let ticketId: string;
  let deviceId2: string;
  let ticketId2: string;
  const userIds: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();

    zoneId = (await prisma.zone.create({ data: { name: 'Z-obx-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-obx-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-obx-' + NS, zoneId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'obx-' + tag, email: `${tag}@obx.test`, zoneId },
    });
    seId = u.userId;
    userIds.push(seId);
    await prisma.engineerMaster.create({ data: { engineerId: seId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 5 } });
    await prisma.seCoverage.create({ data: { seId, plantId, coverageType: 'DEDICATED' } });

    deviceId = String(9_700_000_000 + (NS % 100_000));
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        hasOpenFailureCycle: true,
        latestGpsDatetime: new Date(NOW.getTime() - 60 * 60_000),
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
    ticketId = t.ticketId;
  });

  afterAll(async () => {
    const ledger = await prisma.dispatchRun.findMany({ where: { zoneRows: { some: { zoneId } } }, select: { runId: true } });
    const schedules = await prisma.workSchedule.findMany({ where: { zoneId }, select: { scheduleId: true } });
    const batches = await prisma.plantBatchAssignment.findMany({
      where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } },
      select: { batchId: true },
    });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.dayPlanNotificationOutbox.deleteMany({ where: { seId: { in: userIds } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.workSchedule.deleteMany({ where: { zoneId } });
    await prisma.dispatchDecisionTrace.deleteMany({ where: { ticketId: { in: [ticketId, ticketId2] } } });
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: [ticketId, ticketId2] } } });
    await prisma.dispatchRun.deleteMany({ where: { runId: { in: ledger.map((r) => r.runId) } } });
    await prisma.auditLog.deleteMany({ where: { entityType: 'dispatch_run', entityId: { in: ledger.map((r) => r.runId.toString()) } } });
    await prisma.auditLog.deleteMany({ where: { entityType: { in: ['ticket', 'plant_batch_assignment'] } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: [ticketId, ticketId2] } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: [ticketId, ticketId2] } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: [deviceId, deviceId2] } } });
    await prisma.seCoverage.deleteMany({ where: { plantId } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: [deviceId, deviceId2] } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: [deviceId, deviceId2] } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('AC — dispatch: a notifier throw leaves the run SUCCESS with zero zone errors, and the outbox row carries the error', async () => {
    const notifier = new ThrowingNotifier();
    const rec = new RecommenderService(prisma, new CandidateSelectionService(prisma));
    const dispatch = new BatchAssignmentService(prisma, notifier);
    const runs = new DispatchRunService(prisma, rec, dispatch);

    const outcome = await runs.runForActiveZones(NOW, { zoneId, trigger: 'MANUAL' });
    expect(outcome.result).toBe('RAN');
    if (outcome.result !== 'RAN') return;

    // The core AC: the notifier threw, but the run ledger shows no zone error — the schedule/batch/
    // ticket writes had already committed before the notifier was ever called.
    expect(outcome.summary.errors).toEqual([]);
    expect(outcome.summary.schedules).toBeGreaterThanOrEqual(1);
    expect(notifier.dispatchedCalls.length).toBeGreaterThanOrEqual(1);

    const schedule = await prisma.workSchedule.findFirstOrThrow({ where: { seId, zoneId } });
    expect(schedule.status).toBe('ACTIVE');

    const row = await prisma.dayPlanNotificationOutbox.findFirstOrThrow({
      where: { seId, eventType: 'DAY_PLAN_DISPATCHED' },
    });
    expect(row.sentAt).toBeNull();
    expect(row.lastError).toContain('notifier down');
  });

  it('AC — override: a notifier throw leaves the override committed OK, and the outbox row carries the error', async () => {
    // A second, independent ticket created AFTER test 1's dispatch already consumed the first —
    // `assignTicket` on an already-dispatched ticket would answer ALREADY_ASSIGNED, not exercise the
    // notifier at all.
    deviceId2 = String(9_700_000_000 + (NS % 100_000) + 1);
    await prisma.device.create({ data: { deviceId: deviceId2 } });
    await prisma.deviceState.create({
      data: {
        deviceId: deviceId2,
        isInactive: true,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        hasOpenFailureCycle: true,
        latestGpsDatetime: new Date(NOW.getTime() - 60 * 60_000),
        plantId,
        companyId,
        computedAt: NOW,
      },
    });
    const cycle2 = await prisma.failureCycle.create({ data: { deviceId: deviceId2, state: 'OPEN', openedAt: NOW } });
    const t2 = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        failureCycleId: cycle2.cycleId,
        deviceId: deviceId2,
        plantId,
        companyId,
        companyTier: 'GOLD',
        lastStateChangedAt: NOW,
      },
    });
    ticketId2 = t2.ticketId;

    const notifier = new ThrowingNotifier();
    const override = new OverrideService(prisma, new AuditService(prisma), notifier);
    // A real user, not a synthetic string. #283 gave the *add* side of an assignment the actor column
    // the removal side has had since #241 (`added_by`, uuid, mirroring `removed_by`), so an invented
    // id no longer merely looks odd in an audit row — it is written to a uuid column and rejected.
    // The manager doing the assigning has to exist, which was always true of the behaviour under test.
    const zm = await prisma.user.create({
      data: {
        name: 'ZM obx ' + NS,
        role: 'ZONAL_MANAGER',
        phone: 'zm-obx-' + NS,
        email: `zm-obx-${NS}@obx.test`,
        zoneId,
      },
    });
    userIds.push(zm.userId);
    const actor: ActorContext = { userId: zm.userId, role: 'ZONAL_MANAGER', actedAsRole: null };

    const outcome = await override.assignTicket(
      ticketId2,
      seId,
      { role: 'ZONAL_MANAGER', zoneId: Number(zoneId) },
      actor,
      NOW,
    );
    expect(outcome.result).toBe('OK');
    if (outcome.result !== 'OK') return;

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: ticketId2 } });
    expect(ticket.assignmentState).toBe('FORMALLY_ASSIGNED');

    const row = await prisma.dayPlanNotificationOutbox.findFirstOrThrow({
      where: { seId, eventType: 'DAY_PLAN_OVERRIDDEN' },
    });
    expect(row.sentAt).toBeNull();
    expect(row.lastError).toContain('notifier down');
    expect(notifier.overriddenCalls.length).toBeGreaterThanOrEqual(1);
  });

  /**
   * #345 — the writer half of spine edge E-26. `PLANT_DEACTIVATED` is the first override action no ZM
   * performed, and the first that has to carry a name: "your Day Plan was updated (PLANT_DEACTIVATED)"
   * tells an engineer standing in a yard nothing about *which* stop to drop.
   */
  it('#345 — a PLANT_DEACTIVATED override row round-trips its action and its plant name', async () => {
    const scheduleId = BigInt(NS % 1_000_000);
    const batchId = BigInt((NS % 1_000_000) + 1);
    const rowId = await queueDayPlanOverridden(prisma, {
      seId,
      scheduleId,
      batchId,
      action: DAY_PLAN_ACTION_PLANT_DEACTIVATED,
      plantName: 'STAR CEMENT — Guwahati',
    });

    const stored = await prisma.dayPlanNotificationOutbox.findUniqueOrThrow({ where: { id: rowId } });
    expect(stored.eventType).toBe('DAY_PLAN_OVERRIDDEN');
    expect(stored.payload).toMatchObject({
      action: 'PLANT_DEACTIVATED',
      batchId: String(batchId),
      plantName: 'STAR CEMENT — Guwahati',
    });

    const notifier = new RecordingNotifier();
    await drainRows(prisma, notifier, [rowId]);
    expect(notifier.overriddenCalls).toHaveLength(1);
    expect(notifier.overriddenCalls[0]).toMatchObject({
      seId,
      scheduleId,
      batchId,
      action: 'PLANT_DEACTIVATED',
      plantName: 'STAR CEMENT — Guwahati',
    });
  });

  it('#345 — an override row with no plant name still delivers, with plantName null', async () => {
    const rowId = await queueDayPlanOverridden(prisma, {
      seId,
      scheduleId: BigInt(NS % 1_000_000),
      batchId: BigInt((NS % 1_000_000) + 2),
      action: 'REMOVE_TICKET',
    });
    const notifier = new RecordingNotifier();
    await drainRows(prisma, notifier, [rowId]);
    expect(notifier.overriddenCalls).toHaveLength(1);
    expect(notifier.overriddenCalls[0].plantName ?? null).toBeNull();
  });
});

/**
 * #345 AC2 — the copy. The notice reaches the SE through the existing day-plan channel, so the only
 * place the plant can be named is `SpineDayPlanNotifier`'s body.
 */
describe('#345 — SpineDayPlanNotifier names the deactivated plant', () => {
  const captureNotifier = (): { sent: NotifyInput[]; notifier: SpineDayPlanNotifier } => {
    const sent: NotifyInput[] = [];
    const notifications = {
      notify: async (input: NotifyInput) => {
        sent.push(input);
      },
    } as unknown as NotificationService;
    return { sent, notifier: new SpineDayPlanNotifier(notifications) };
  };

  it('names the plant in the body a PLANT_DEACTIVATED notice', async () => {
    const { sent, notifier } = captureNotifier();
    await notifier.dayPlanOverridden({
      seId: 'se-1',
      scheduleId: 1n,
      batchId: 2n,
      action: DAY_PLAN_ACTION_PLANT_DEACTIVATED,
      plantName: 'STAR CEMENT — Guwahati',
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toContain('STAR CEMENT — Guwahati');
    expect(sent[0].metadata).toMatchObject({ action: 'PLANT_DEACTIVATED', plantName: 'STAR CEMENT — Guwahati' });
  });

  it('falls back to a nameless sentence rather than printing "undefined"', async () => {
    const { sent, notifier } = captureNotifier();
    await notifier.dayPlanOverridden({
      seId: 'se-1',
      scheduleId: 1n,
      batchId: 2n,
      action: DAY_PLAN_ACTION_PLANT_DEACTIVATED,
    });
    expect(sent[0].body).not.toContain('undefined');
    expect(sent[0].body.toLowerCase()).toContain('deactivated');
  });

  it('leaves every other override action copy untouched', async () => {
    const { sent, notifier } = captureNotifier();
    await notifier.dayPlanOverridden({ seId: 'se-1', scheduleId: 1n, batchId: 2n, action: 'REMOVE_TICKET' });
    expect(sent[0].body).toBe('Your Day Plan was updated (REMOVE_TICKET).');
  });
});
