import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import { SeAvailabilityService } from '../src/engineers/se-availability.service';
import { IntradayInsertionService } from '../src/intraday/intraday-insertion.service';
import { NotificationService, type NotifyInput } from '../src/notifications/notification.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { NOTIFY_EVENT_TYPE, drainRows } from '../src/scheduling/day-plan-notification-outbox';
import type { DayPlanNotifier } from '../src/scheduling/day-plan-notifier';
import { OverrideService } from '../src/scheduling/override.service';
import { StrandedWorkEscalationService } from '../src/intraday/stranded-work-escalation.service';

/**
 * #338 — the intraday module's `notify()` sites become durable outbox rows.
 *
 * **The gap.** `IntradayInsertionService` pushes three notices *after* its transaction commits with
 * nothing durable behind them: the SE's "CRITICAL ticket added to your Day Plan" (direct assign), the
 * SE's "assigned to you" (the ZM's manual assign), and the ZM's "Manual assignment needed"
 * (escalation). A crash between the commit and the call loses the notice with no trace, and a *throw*
 * in the call propagates back into a caller whose work has already committed — the sweep abandons the
 * rest of the zone's CRITICAL tickets because a push failed.
 *
 * **Why this trio first.** #325 already opened a transaction seam here — `assignTicket`'s
 * `inTransaction` hook — so these are the sites whose mutation transaction *exists today*, and
 * therefore the only ones that can satisfy AC1 in its strong form ("enqueued inside the mutation
 * transaction") rather than the weaker "enqueued on `this.prisma`" that the sites with no transaction
 * are stuck with until #354.
 *
 * **Two properties per site, and they are different properties.**
 * - *Durability (AC2/AC5).* The notifier throws. The mutation must still commit, the notice must
 *   survive as an unsent row, and a later drain — the sweep's, which carries a real deliverer — must
 *   deliver it exactly once. Draining twice must not deliver twice: the claim precedes the delivery.
 * - *Atomicity (AC1).* The enqueue itself fails. The mutation must roll back with it, which is only
 *   true if the enqueue really is inside the mutation's transaction. This is what tells an
 *   in-transaction enqueue apart from a post-commit one that merely happens to write a row.
 *
 * The fixture is #325's (`intraday-ledger-atomicity.e2e-spec.ts`) — same zone/plant/SE shape, same
 * real Q-B escalation — because these are the same three doors and re-deriving the setup would only
 * risk testing a different one.
 *
 * The fourth door is `StrandedWorkEscalationService` (#288), the module's other producer: it writes
 * one ledger row per stranded ticket and **one** alert per zone. It owned no transaction at all, so
 * the atomicity property there is the stronger claim — all of its rows and its alert commit together,
 * where before a crash mid-loop left some tickets escalated, some not, and nobody told about any.
 */
const NS = Date.now();
/** 11:30 IST on the operating day the fixture builds. */
const BASE = new Date('2026-06-29T06:00:00Z');
const DAY = new Date('2026-06-29T00:00:00Z');

class NotifyFailed extends Error {
  constructor() {
    super('injected: the notification delivery failed');
    this.name = 'NotifyFailed';
  }
}

class EnqueueFailed extends Error {
  constructor() {
    super('injected: the notification enqueue failed');
    this.name = 'EnqueueFailed';
  }
}

/** A notification service that cannot deliver — the crash, injected where a push would happen. */
function throwingNotifications(): NotificationService {
  return {
    notify: async () => {
      throw new NotifyFailed();
    },
  } as unknown as NotificationService;
}

/**
 * A client on which enqueueing a *general* notice throws — on the client itself and on any
 * transaction client it hands out.
 *
 * Deliberately narrowed to `eventType === NOTIFY`: the day-plan row `assignTicket` writes in the same
 * transaction must keep working, or the rollback under test would be caused by the wrong write.
 */
function failingNotifyEnqueue(prisma: PrismaService): PrismaService {
  const wrapDelegate = (delegate: object): object =>
    new Proxy(delegate, {
      get(d, dp) {
        if (dp !== 'create') return Reflect.get(d, dp);
        return async (args: { data?: { eventType?: string } }) => {
          if (args?.data?.eventType === NOTIFY_EVENT_TYPE) throw new EnqueueFailed();
          const create = Reflect.get(d, 'create') as (a: unknown) => Promise<unknown>;
          return create.call(d, args);
        };
      },
    });

  const wrapClient = (client: object): object =>
    new Proxy(client, {
      get(target, prop, receiver) {
        if (prop === 'dayPlanNotificationOutbox') {
          return wrapDelegate(Reflect.get(target, prop, receiver) as object);
        }
        if (prop === '$transaction') {
          return (fn: unknown, ...rest: unknown[]) => {
            const real = (target as unknown as Record<string, (...a: unknown[]) => unknown>).$transaction;
            if (typeof fn !== 'function') return real.call(target, fn, ...rest);
            return real.call(target, ((tx: object) => (fn as (t: object) => unknown)(wrapClient(tx))) as never, ...rest);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

  return wrapClient(prisma) as PrismaService;
}

/** The day-plan half of the drain, which none of these rows exercise. */
const inertDayPlanNotifier: DayPlanNotifier = {
  dayPlanDispatched: async () => {},
  dayPlanOverridden: async () => {},
};

describe('#338 — the intraday notices are durable outbox rows', () => {
  let prisma: PrismaService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let zmUserId: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];

  const zmScope = () => ({ role: 'ZONAL_MANAGER', zoneId: Number(zoneId) });
  const zmActor = () => ({ userId: zmUserId, role: 'ZONAL_MANAGER', actedAsRole: null });

  /** Build the services over one client — the real wiring, with `client` and the notifier swappable. */
  const servicesOn = (client: PrismaService, notifications: NotificationService = new NotificationService(client)) => {
    const override = new OverrideService(client, new AuditService(client), inertDayPlanNotifier);
    const intraday = new IntradayInsertionService(
      client,
      new CandidateSelectionService(client),
      override,
      notifications,
      new SeAvailabilityService(client),
      new AuditService(client),
    );
    return { override, intraday };
  };

  const payloadOf = (row: { payload: unknown }): NotifyInput => (row.payload ?? {}) as unknown as NotifyInput;

  /** The general-notice rows this ticket produced, whichever of the three doors wrote them. */
  const notifyRowsFor = async (ticketId: string) => {
    const rows = await prisma.dayPlanNotificationOutbox.findMany({
      where: { eventType: NOTIFY_EVENT_TYPE },
      orderBy: { id: 'asc' },
    });
    return rows.filter((r) => {
      const p = payloadOf(r);
      const meta = p.metadata as Record<string, unknown> | null | undefined;
      // Three shapes, because the four doors name their ticket in three places: the entity itself,
      // a single `ticketId`, or — for the one alert that stands for a whole stranded day — a list.
      const listed = Array.isArray(meta?.ticketIds) && (meta.ticketIds as unknown[]).includes(ticketId);
      return p.entityId === ticketId || String(meta?.ticketId ?? '') === ticketId || listed;
    });
  };

  const makeSe = async (opts: { dailyCapacity?: number } = {}): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@no.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({
      data: { engineerId: u.userId, coverageType: 'DEDICATED', zoneId, dailyCapacity: opts.dailyCapacity ?? 10 },
    });
    await prisma.seCoverage.create({ data: { seId: u.userId, plantId, coverageType: 'DEDICATED' } });
    return u.userId;
  };

  const makeCriticalTicket = async (): Promise<string> => {
    const deviceId = String(12_338_000_000 + ((NS + deviceIds.length) % 100_000) + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        hasOpenFailureCycle: true,
        latestGpsDatetime: new Date(BASE.getTime() - 30 * 60 * 60_000),
        plantId,
        companyId,
        computedAt: BASE,
      },
    });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: BASE } });
    const t = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        failureCycleId: cycle.cycleId,
        deviceId,
        plantId,
        companyId,
        companyTier: 'GOLD',
        lastStateChangedAt: BASE,
      },
    });
    ticketIds.push(t.ticketId);
    return t.ticketId;
  };

  /** Fill the zone's only SE to capacity, so the next CRITICAL ticket escalates instead of assigning. */
  const fillTheZone = async (): Promise<void> => {
    const se = await makeSe({ dailyCapacity: 1 });
    const schedule = await prisma.workSchedule.create({
      data: { seId: se, zoneId, dateFrom: DAY, dateTo: DAY, status: 'ACTIVE', dispatchedAt: BASE },
    });
    const filler = await makeCriticalTicket();
    const batch = await prisma.plantBatchAssignment.create({
      data: { scheduleId: schedule.scheduleId, plantId, seId: se, status: 'AUTO_ASSIGNED', stopSequence: 1 },
    });
    await prisma.batchAssignmentTicket.create({ data: { batchId: batch.batchId, ticketId: filler, sortOrder: 1 } });
    await prisma.ticket.update({ where: { ticketId: filler }, data: { assignmentState: 'FORMALLY_ASSIGNED' } });
  };

  /** The real Q-B escalation (#258/#298) — the state the ZM's manual-assign door is reached from. */
  const escalate = async (intraday: IntradayInsertionService): Promise<{ ticketId: string; insertionId: bigint }> => {
    await fillTheZone();
    const ticketId = await makeCriticalTicket();
    expect(await intraday.assignCriticalForZone(zoneId, BASE)).toEqual({ assigned: 0, escalated: 1 });
    const ins = await prisma.intradayInsertion.findFirstOrThrow({
      where: { ticketId },
      orderBy: { insertionId: 'desc' },
    });
    expect(ins.status).toBe('ESCALATION_REQUIRED');
    return { ticketId, insertionId: ins.insertionId };
  };

  /** One live day plan for today — the shape dispatch leaves behind (#288's own fixture). */
  const givePlan = async (seId: string, tickets: string[]): Promise<void> => {
    const schedule = await prisma.workSchedule.create({
      data: { seId, zoneId, dateFrom: DAY, dateTo: DAY, status: 'ACTIVE', dispatchedAt: BASE },
    });
    const batch = await prisma.plantBatchAssignment.create({
      data: { scheduleId: schedule.scheduleId, plantId, seId, stopSequence: 1, status: 'AUTO_ASSIGNED' },
    });
    let sortOrder = 1;
    for (const ticketId of tickets) {
      await prisma.batchAssignmentTicket.create({ data: { batchId: batch.batchId, ticketId, sortOrder: sortOrder++ } });
      await prisma.ticket.update({ where: { ticketId }, data: { assignmentState: 'FORMALLY_ASSIGNED' } });
    }
  };

  const liveRowsFor = (ticketId: string) =>
    prisma.batchAssignmentTicket.findMany({ where: { ticketId, removedAt: null } });

  const deliveredCount = (recipientUserId: string, type: string) =>
    prisma.notification.count({ where: { recipientUserId, type } });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();

    const zm = await prisma.user.create({
      data: { name: 'ZM ' + NS, role: 'ZONAL_MANAGER', phone: 'zm-no-' + NS, email: `zm-no-${NS}@no.test` },
    });
    zmUserId = zm.userId;
    userIds.push(zm.userId);
    zoneId = (await prisma.zone.create({ data: { name: 'Z-338-' + NS, zonalManagerUserId: zm.userId } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-338-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-338-' + NS, zoneId } })).plantId;
  });

  afterEach(async () => {
    // General rows carry no `se_id` and no `schedule_id` — that is the point of them — so they cannot
    // be cleaned by the id-scoped delete the day-plan rows use. Matched on their own payload instead.
    const notifyRows = await prisma.dayPlanNotificationOutbox.findMany({ where: { eventType: NOTIFY_EVENT_TYPE } });
    const mine = notifyRows
      .filter((r) => {
        const p = payloadOf(r);
        const recipient = p.recipients?.[0]?.userId;
        return (
          (recipient != null && userIds.includes(recipient)) || (p.entityId != null && ticketIds.includes(p.entityId))
        );
      })
      .map((r) => r.id);
    if (mine.length > 0) await prisma.dayPlanNotificationOutbox.deleteMany({ where: { id: { in: mine } } });

    await prisma.intradayInsertion.deleteMany({ where: { zoneId } });
    const schedules = await prisma.workSchedule.findMany({ where: { zoneId }, select: { scheduleId: true } });
    const batches = await prisma.plantBatchAssignment.findMany({
      where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } },
      select: { batchId: true },
    });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.dayPlanNotificationOutbox.deleteMany({
      where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } },
    });
    await prisma.plantBatchAssignment.deleteMany({ where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } } });
    await prisma.workSchedule.deleteMany({ where: { zoneId } });
    await prisma.notification.deleteMany({ where: { recipientUserId: { in: userIds } } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [...ticketIds, ...userIds] } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seCoverage.deleteMany({ where: { plantId } });
    await prisma.seAvailability.deleteMany({ where: { seId: { in: userIds } } });
    // Zone-scoped, not id-scoped: an engineer surviving a test is spare capacity, and it silently
    // turns the next test's escalation into an assignment.
    await prisma.engineerMaster.deleteMany({ where: { zoneId } });
    await prisma.user.deleteMany({ where: { zoneId, userId: { not: zmUserId } } });
    ticketIds.length = 0;
    deviceIds.length = 0;
    userIds.length = 1;
  });

  afterAll(async () => {
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.user.deleteMany({ where: { userId: zmUserId } });
    await prisma.onModuleDestroy();
  });

  describe('the system CRITICAL direct assign', () => {
    it('AC2/AC5 — a notifier that throws leaves the assignment committed and the notice retryable', async () => {
      const { intraday } = servicesOn(prisma, throwingNotifications());
      const seId = await makeSe();
      const ticketId = await makeCriticalTicket();

      // The sweep does not abandon the zone because a push failed — this used to reject.
      expect(await intraday.assignCriticalForZone(zoneId, BASE)).toEqual({ assigned: 1, escalated: 0 });

      const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
      expect(ticket.assignmentState).toBe('FORMALLY_ASSIGNED');
      expect(await liveRowsFor(ticketId)).toHaveLength(1);

      const rows = await notifyRowsFor(ticketId);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(payloadOf(row).type).toBe('INTRADAY_DIRECT_ASSIGNED');
      expect(payloadOf(row).recipients[0]!.userId).toBe(seId);
      // Un-claimed by the failed attempt, so the sweep will pick it up — and visibly so.
      expect(row.sentAt).toBeNull();
      expect(row.attempts).toBe(1);
      expect(row.lastError).toMatch(/injected/);
      expect(await deliveredCount(seId, 'INTRADAY_DIRECT_ASSIGNED')).toBe(0);

      // The next drain carries a deliverer that works. It delivers once — and only once.
      await drainRows(prisma, inertDayPlanNotifier, [row.id], BASE, new NotificationService(prisma));
      expect(await deliveredCount(seId, 'INTRADAY_DIRECT_ASSIGNED')).toBe(1);
      await drainRows(prisma, inertDayPlanNotifier, [row.id], BASE, new NotificationService(prisma));
      expect(await deliveredCount(seId, 'INTRADAY_DIRECT_ASSIGNED')).toBe(1);
    });

    it('AC1 — a failed enqueue rolls the assignment back, so the notice is inside its transaction', async () => {
      const { intraday } = servicesOn(failingNotifyEnqueue(prisma));
      await makeSe();
      const ticketId = await makeCriticalTicket();

      await expect(intraday.assignCriticalForZone(zoneId, BASE)).rejects.toThrow(EnqueueFailed);

      const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
      expect(ticket.assignmentState).toBe('UNASSIGNED');
      expect(await liveRowsFor(ticketId)).toHaveLength(0);
      expect(await prisma.intradayInsertion.count({ where: { ticketId } })).toBe(0);
      expect(await notifyRowsFor(ticketId)).toHaveLength(0);
    });
  });

  describe("the ZM's manual assign from the escalation queue", () => {
    it('AC2/AC5 — a notifier that throws leaves the assignment committed and the notice retryable', async () => {
      const { intraday: escalator } = servicesOn(prisma);
      const { ticketId, insertionId } = await escalate(escalator);
      const target = await makeSe();

      const { intraday } = servicesOn(prisma, throwingNotifications());
      const out = await intraday.manualAssign(insertionId, target, zmActor(), zmScope(), BASE);
      expect(out.result).toBe('OK');

      const ins = await prisma.intradayInsertion.findUniqueOrThrow({ where: { insertionId } });
      expect(ins.status).toBe('ACCEPTED');
      expect(await liveRowsFor(ticketId)).toHaveLength(1);

      const rows = (await notifyRowsFor(ticketId)).filter((r) => payloadOf(r).type === 'INTRADAY_MANUAL_ASSIGNED');
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(payloadOf(row).recipients[0]!.userId).toBe(target);
      expect(row.sentAt).toBeNull();
      expect(await deliveredCount(target, 'INTRADAY_MANUAL_ASSIGNED')).toBe(0);

      await drainRows(prisma, inertDayPlanNotifier, [row.id], BASE, new NotificationService(prisma));
      expect(await deliveredCount(target, 'INTRADAY_MANUAL_ASSIGNED')).toBe(1);
      await drainRows(prisma, inertDayPlanNotifier, [row.id], BASE, new NotificationService(prisma));
      expect(await deliveredCount(target, 'INTRADAY_MANUAL_ASSIGNED')).toBe(1);
    });

    it('AC1 — a failed enqueue rolls the manual assignment back, ledger stamp included', async () => {
      const { intraday: escalator } = servicesOn(prisma);
      const { ticketId, insertionId } = await escalate(escalator);
      const target = await makeSe();

      const { intraday } = servicesOn(failingNotifyEnqueue(prisma));
      await expect(intraday.manualAssign(insertionId, target, zmActor(), zmScope(), BASE)).rejects.toThrow(
        EnqueueFailed,
      );

      const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
      expect(ticket.assignmentState).toBe('UNASSIGNED');
      expect(await liveRowsFor(ticketId)).toHaveLength(0);
      const ins = await prisma.intradayInsertion.findUniqueOrThrow({ where: { insertionId } });
      expect(ins.status).toBe('ESCALATION_REQUIRED');
      expect(ins.assignedScheduleId).toBeNull();
    });
  });

  describe("the ZM's 'manual assignment needed' escalation", () => {
    it('AC2/AC5 — a notifier that throws leaves the escalation row committed and the notice retryable', async () => {
      const { intraday } = servicesOn(prisma, throwingNotifications());
      await fillTheZone();
      const ticketId = await makeCriticalTicket();

      expect(await intraday.assignCriticalForZone(zoneId, BASE)).toEqual({ assigned: 0, escalated: 1 });

      // The ledger row is what the Intra-day Queue reads — it must survive a failed push.
      const ins = await prisma.intradayInsertion.findFirstOrThrow({
        where: { ticketId },
        orderBy: { insertionId: 'desc' },
      });
      expect(ins.status).toBe('ESCALATION_REQUIRED');

      const rows = await notifyRowsFor(ticketId);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(payloadOf(row).type).toBe('INTRADAY_ESCALATION_REQUIRED');
      expect(payloadOf(row).recipients[0]!.userId).toBe(zmUserId);
      expect(row.sentAt).toBeNull();
      expect(await deliveredCount(zmUserId, 'INTRADAY_ESCALATION_REQUIRED')).toBe(0);

      await drainRows(prisma, inertDayPlanNotifier, [row.id], BASE, new NotificationService(prisma));
      expect(await deliveredCount(zmUserId, 'INTRADAY_ESCALATION_REQUIRED')).toBe(1);
      await drainRows(prisma, inertDayPlanNotifier, [row.id], BASE, new NotificationService(prisma));
      expect(await deliveredCount(zmUserId, 'INTRADAY_ESCALATION_REQUIRED')).toBe(1);
    });

    it('AC1 — the escalation ledger row and its notice commit together or not at all', async () => {
      const { intraday } = servicesOn(failingNotifyEnqueue(prisma));
      await fillTheZone();
      const ticketId = await makeCriticalTicket();

      await expect(intraday.assignCriticalForZone(zoneId, BASE)).rejects.toThrow(EnqueueFailed);

      // Before this slice the create and the notify were two separate awaits: the row committed and
      // the notice was simply lost. A queue row nobody was told about is the gap NOTIF-02 names.
      expect(await prisma.intradayInsertion.count({ where: { ticketId } })).toBe(0);
      expect(await notifyRowsFor(ticketId)).toHaveLength(0);
    });
  });

  describe("the unavailable engineer's stranded work (#288)", () => {
    it('AC2/AC5 — a notifier that throws leaves every escalation committed and the one alert retryable', async () => {
      const stranded = new StrandedWorkEscalationService(prisma, throwingNotifications());
      const seId = await makeSe();
      const t1 = await makeCriticalTicket();
      const t2 = await makeCriticalTicket();
      await givePlan(seId, [t1, t2]);

      const out = await stranded.escalateStrandedWork(seId, BASE);
      expect(out.escalated).toBe(2);

      // One ledger row per ticket — the Intra-day Queue's contents — and they survive the failed push.
      expect(await prisma.intradayInsertion.count({ where: { ticketId: { in: [t1, t2] } } })).toBe(2);

      // …but ONE alert, which is #288's own rule: the decision is single even though the rows are not.
      const rows = await notifyRowsFor(t1);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(payloadOf(row).type).toBe('INTRADAY_ESCALATION_REQUIRED');
      expect(payloadOf(row).recipients[0]!.userId).toBe(zmUserId);
      expect(payloadOf(row).entityId).toBe(seId);
      expect(row.sentAt).toBeNull();
      expect(await deliveredCount(zmUserId, 'INTRADAY_ESCALATION_REQUIRED')).toBe(0);

      await drainRows(prisma, inertDayPlanNotifier, [row.id], BASE, new NotificationService(prisma));
      expect(await deliveredCount(zmUserId, 'INTRADAY_ESCALATION_REQUIRED')).toBe(1);
      await drainRows(prisma, inertDayPlanNotifier, [row.id], BASE, new NotificationService(prisma));
      expect(await deliveredCount(zmUserId, 'INTRADAY_ESCALATION_REQUIRED')).toBe(1);
    });

    it('AC1 — every ledger row and the alert commit together, or none of them do', async () => {
      const stranded = new StrandedWorkEscalationService(failingNotifyEnqueue(prisma));
      const seId = await makeSe();
      const t1 = await makeCriticalTicket();
      const t2 = await makeCriticalTicket();
      await givePlan(seId, [t1, t2]);

      await expect(stranded.escalateStrandedWork(seId, BASE)).rejects.toThrow(EnqueueFailed);

      // This door wrote its rows one bare `create` at a time and then alerted, so a crash mid-loop
      // left an engineer's day half-escalated with nobody told — the partial state #288's re-escalation
      // guard then *suppresses*, because a live row is its "a human already knows" marker.
      expect(await prisma.intradayInsertion.count({ where: { ticketId: { in: [t1, t2] } } })).toBe(0);
      expect(await notifyRowsFor(t1)).toHaveLength(0);
    });
  });
});
