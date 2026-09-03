import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import { SeAvailabilityService } from '../src/engineers/se-availability.service';
import { IntradayInsertionService } from '../src/intraday/intraday-insertion.service';
import { NotificationService } from '../src/notifications/notification.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import type { DayPlanNotifier } from '../src/scheduling/day-plan-notifier';
import { OverrideService } from '../src/scheduling/override.service';

/**
 * #325 (RC-9) — the intraday ledger row commits with the assignment it describes.
 *
 * **The gap.** `IntradayInsertionService` writes its `intraday_insertions` row *after*
 * `assignTicket`'s transaction has committed — the direct-assign creates its `ASSIGNED_DIRECT` row at
 * :318, `manualAssign` stamps the ids at :435. Two writers, two transactions, no shared boundary. A
 * crash in the gap leaves an assigned CRITICAL ticket with no ledger row at all (the Intra-day Queue's
 * completeness and the efficiency cube's inputs both read that table), or — on the manual door — a row
 * that says ACCEPTED while carrying no `assigned_schedule_id`, an assignment whose ledger cannot say
 * where the work went.
 *
 * **Re-scoped after #298, as the issue instructs.** #298 moved the `ESCALATION_REQUIRED → ACCEPTED`
 * close *into* `assignTicket`'s transaction, so the manual door's "row stays live-looking while the
 * ticket is assigned" half is already closed. What remains for that door is narrower and still real:
 * the schedule/batch ids. What remains for the direct-assign door is the whole row.
 *
 * **How the crash is injected.** A Prisma proxy makes the ledger write throw — at the top level *and*
 * inside `$transaction`, because the point of the fix is that the call moves from one to the other and
 * the same spec must be able to fail before and pass after. It targets `create`/`update` by name and
 * deliberately leaves `updateMany` alone: that is #298's in-transaction escalation close, and breaking
 * it would test a different thing. Both services are built on the interfering client, because
 * `withAudit` opens the transaction on the `AuditService`'s own connection.
 */
const NS = Date.now();
/** 11:30 IST on the operating day the fixture builds. */
const BASE = new Date('2026-06-28T06:00:00Z');
const DAY = new Date('2026-06-28T00:00:00Z');

class LedgerWriteFailed extends Error {
  constructor() {
    super('injected: the intraday ledger write failed');
    this.name = 'LedgerWriteFailed';
  }
}

/**
 * A client on which `intradayInsertion[method]` throws — on the client itself and on any transaction
 * client it hands out, so it catches the write wherever this issue leaves it.
 */
function failingLedgerWrite(prisma: PrismaService, method: 'create' | 'update'): PrismaService {
  const wrapDelegate = (delegate: object): object =>
    new Proxy(delegate, {
      get(d, dp) {
        if (dp !== method) return Reflect.get(d, dp);
        return async () => {
          throw new LedgerWriteFailed();
        };
      },
    });

  const wrapClient = (client: object): object =>
    new Proxy(client, {
      get(target, prop, receiver) {
        if (prop === 'intradayInsertion') {
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

/** Records what would have been pushed, so "no notification for a rolled-back assign" is assertable. */
class RecordingDayPlanNotifier implements DayPlanNotifier {
  readonly events: string[] = [];
  dayPlanDispatched(): void {
    this.events.push('DISPATCHED');
  }
  dayPlanOverridden(): void {
    this.events.push('OVERRIDDEN');
  }
}

describe('#325 — the intraday ledger row commits with its assignment', () => {
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

  /** Build the two services over one client — the real wiring, with `client` swappable for the proxy. */
  const servicesOn = (client: PrismaService, notifier: DayPlanNotifier) => {
    const override = new OverrideService(client, new AuditService(client), notifier);
    const intraday = new IntradayInsertionService(
      client,
      new CandidateSelectionService(client),
      override,
      new NotificationService(client),
      new SeAvailabilityService(client),
      new AuditService(client),
    );
    return { override, intraday };
  };

  const makeSe = async (opts: { dailyCapacity?: number } = {}): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@la.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({
      data: { engineerId: u.userId, coverageType: 'DEDICATED', zoneId, dailyCapacity: opts.dailyCapacity ?? 10 },
    });
    await prisma.seCoverage.create({ data: { seId: u.userId, plantId, coverageType: 'DEDICATED' } });
    return u.userId;
  };

  const makeCriticalTicket = async (): Promise<string> => {
    const deviceId = String(12_325_000_000 + ((NS + deviceIds.length) % 100_000) + deviceIds.length);
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

  /**
   * The real Q-B escalation, produced by the real writer (#258/#298): the only eligible SE is at
   * capacity, so the sweep refuses to self-authorise the overload and escalates. That is the state the
   * ZM's manual-assign door is reached from.
   */
  const escalate = async (intraday: IntradayInsertionService): Promise<{ ticketId: string; insertionId: bigint }> => {
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

    const ticketId = await makeCriticalTicket();
    expect(await intraday.assignCriticalForZone(zoneId, BASE)).toEqual({ assigned: 0, escalated: 1 });
    const ins = await prisma.intradayInsertion.findFirstOrThrow({
      where: { ticketId },
      orderBy: { insertionId: 'desc' },
    });
    expect(ins.status).toBe('ESCALATION_REQUIRED');
    return { ticketId, insertionId: ins.insertionId };
  };

  const liveRowsFor = (ticketId: string) =>
    prisma.batchAssignmentTicket.findMany({ where: { ticketId, removedAt: null } });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();

    const zm = await prisma.user.create({
      data: { name: 'ZM ' + NS, role: 'ZONAL_MANAGER', phone: 'zm-la-' + NS, email: `zm-la-${NS}@la.test` },
    });
    zmUserId = zm.userId;
    userIds.push(zm.userId);
    zoneId = (await prisma.zone.create({ data: { name: 'Z-325-' + NS, zonalManagerUserId: zm.userId } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-325-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-325-' + NS, zoneId } })).plantId;
  });

  afterEach(async () => {
    await prisma.intradayInsertion.deleteMany({ where: { zoneId } });
    const schedules = await prisma.workSchedule.findMany({ where: { zoneId }, select: { scheduleId: true } });
    const batches = await prisma.plantBatchAssignment.findMany({
      where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } },
      select: { batchId: true },
    });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.dayPlanNotificationOutbox.deleteMany({ where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } } });
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
    // Zone-scoped, not id-scoped: an engineer surviving a test is not a leak, it is spare capacity,
    // and it silently turns the next test's escalation into an assignment.
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

  describe('AC1 — the system CRITICAL direct-assign', () => {
    it('control — the assignment and its ASSIGNED_DIRECT row both land, pointing at the same batch', async () => {
      const notifier = new RecordingDayPlanNotifier();
      const { intraday } = servicesOn(prisma, notifier);
      await makeSe();
      const ticketId = await makeCriticalTicket();

      expect(await intraday.assignCriticalForZone(zoneId, BASE)).toEqual({ assigned: 1, escalated: 0 });

      const rows = await liveRowsFor(ticketId);
      expect(rows).toHaveLength(1);
      const ins = await prisma.intradayInsertion.findFirstOrThrow({ where: { ticketId } });
      expect(ins.status).toBe('ASSIGNED_DIRECT');
      // The ledger must describe *this* assignment, not merely exist beside it.
      expect(ins.assignedBatchId).toBe(rows[0].batchId);
      expect(notifier.events).toContain('OVERRIDDEN');
    });

    it('a failed ledger write takes the assignment with it — no assigned ticket without its row', async () => {
      const notifier = new RecordingDayPlanNotifier();
      const { intraday } = servicesOn(failingLedgerWrite(prisma, 'create'), notifier);
      await makeSe();
      const ticketId = await makeCriticalTicket();

      await expect(intraday.assignCriticalForZone(zoneId, BASE)).rejects.toThrow(LedgerWriteFailed);

      // The whole point: the ticket is still the pool's, not silently assigned with no ledger entry.
      const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
      expect(ticket.assignmentState).toBe('UNASSIGNED');
      expect(await liveRowsFor(ticketId)).toHaveLength(0);
      expect(await prisma.intradayInsertion.count({ where: { ticketId } })).toBe(0);
    });

    it('AC2 — nothing is pushed for an assignment that rolled back', async () => {
      const notifier = new RecordingDayPlanNotifier();
      const { intraday } = servicesOn(failingLedgerWrite(prisma, 'create'), notifier);
      const seId = await makeSe();
      const ticketId = await makeCriticalTicket();

      await expect(intraday.assignCriticalForZone(zoneId, BASE)).rejects.toThrow(LedgerWriteFailed);

      // Both spines: the Day Plan push (drained post-commit inside `assignTicket`) and the SE's own
      // CRITICAL notification. An SE told their plan changed, for a change that did not happen, is the
      // failure this AC names — and it is newly possible precisely because there is now a rollback.
      expect(notifier.events).toEqual([]);
      expect(await prisma.notification.count({ where: { recipientUserId: seId } })).toBe(0);
      // …and no orphan outbox row waiting to be drained by the next tick.
      expect(await prisma.dayPlanNotificationOutbox.count({ where: { seId } })).toBe(0);
      expect(ticketId).toBeTruthy();
    });
  });

  describe("AC1 — the ZM's manual assign from the escalation queue", () => {
    it('control — the row is stamped ACCEPTED and carries the schedule and batch it was assigned to', async () => {
      const notifier = new RecordingDayPlanNotifier();
      const { intraday } = servicesOn(prisma, notifier);
      const { ticketId, insertionId } = await escalate(intraday);
      const target = await makeSe();

      const out = await intraday.manualAssign(insertionId, target, zmActor(), zmScope(), BASE);
      expect(out.result).toBe('OK');

      const rows = await liveRowsFor(ticketId);
      const ins = await prisma.intradayInsertion.findUniqueOrThrow({ where: { insertionId } });
      expect(ins.status).toBe('ACCEPTED');
      expect(ins.offeredSeId).toBe(target);
      expect(ins.assignedBatchId).toBe(rows[0].batchId);
    });

    /**
     * #298 already closes the row inside the transaction, so the status alone would look right after a
     * crash here. What is asserted is the pair: an ACCEPTED row that cannot say which schedule or batch
     * the work went onto is a ledger entry that does not describe an assignment.
     */
    it('a failed id stamp takes the assignment with it — no ACCEPTED row without its schedule and batch', async () => {
      const notifier = new RecordingDayPlanNotifier();
      const { intraday: escalator } = servicesOn(prisma, notifier);
      const { ticketId, insertionId } = await escalate(escalator);
      const target = await makeSe();

      const { intraday } = servicesOn(failingLedgerWrite(prisma, 'update'), notifier);
      await expect(intraday.manualAssign(insertionId, target, zmActor(), zmScope(), BASE)).rejects.toThrow(
        LedgerWriteFailed,
      );

      const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
      expect(ticket.assignmentState).toBe('UNASSIGNED');
      expect(await liveRowsFor(ticketId)).toHaveLength(0);
      const ins = await prisma.intradayInsertion.findUniqueOrThrow({ where: { insertionId } });
      expect(ins.status).toBe('ESCALATION_REQUIRED');
      expect(ins.assignedScheduleId).toBeNull();
    });
  });
});
