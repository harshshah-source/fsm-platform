import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import { LeaveRequestService } from '../src/engineers/leave-request.service';
import { IntradayInsertionService } from '../src/intraday/intraday-insertion.service';
import { NotificationService } from '../src/notifications/notification.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { LoggingDayPlanNotifier } from '../src/scheduling/day-plan-notifier';
import { DispatchTodayQueryService } from '../src/scheduling/dispatch-today-query.service';
import { OverrideService } from '../src/scheduling/override.service';
import { SeAvailabilityService } from '../src/engineers/se-availability.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * #288 — an SE who becomes unavailable mid-day does not silently strand their work.
 *
 * **Escalate-only** (#282 R4, operator, 2026-08-25). Nothing re-plans: the day plan is not rewritten,
 * no assignment row is touched, no capacity is bypassed. What changes is that the SE's remaining
 * committed work becomes *visible as work needing a human decision* — an `ESCALATION_REQUIRED` row on
 * the existing intra-day ledger, which is the surface a ZM already resolves through (`manualAssign` /
 * the Intra-day Queue).
 *
 * The seam under test is the availability write itself, because that is the one place every
 * unavailability lands: `LeaveRequestService.approve` delegates to it, and so does a manager or an SE
 * setting a window directly. Two seams would be two definitions of "unavailable".
 */
const NS = Date.now();
/** 11:00 IST on the operating day the fixture builds — well inside the field day. */
const NOW = new Date('2026-06-28T05:30:00Z');
const DAY = new Date('2026-06-28T00:00:00Z');

describe('#288 — unavailable SE, stranded work', () => {
  let prisma: PrismaService;
  let availability: SeAvailabilityService;
  let leave: LeaveRequestService;
  let intraday: IntradayInsertionService;
  let cockpit: DispatchTodayQueryService;
  let override: OverrideService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let zmUserId: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];

  const zmActor = () => ({ userId: zmUserId, role: 'ZONAL_MANAGER', zoneId: Number(zoneId), actedAsRole: null });

  const makeSe = async (): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@sw.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({
      data: { engineerId: u.userId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 },
    });
    return u.userId;
  };

  const makeTicket = async (status: 'OPEN' | 'SUBMITTED' = 'OPEN'): Promise<string> => {
    const deviceId = String(11_800_000_000 + ((NS + deviceIds.length) % 100_000) + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: { deviceId, isInactive: true, slaBucket: 'CRITICAL', plantId, companyId, computedAt: NOW },
    });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
    const t = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status,
        assignmentState: 'FORMALLY_ASSIGNED',
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

  /** One live day plan for today: one stop, one row per ticket — the shape dispatch leaves behind. */
  const givePlan = async (seId: string, tickets: string[]): Promise<bigint> => {
    const schedule = await prisma.workSchedule.create({
      data: { seId, zoneId, dateFrom: DAY, dateTo: DAY, status: 'ACTIVE' },
    });
    const batch = await prisma.plantBatchAssignment.create({
      data: { scheduleId: schedule.scheduleId, plantId, seId, stopSequence: 1, status: 'AUTO_ASSIGNED' },
    });
    let sortOrder = 1;
    for (const ticketId of tickets) {
      await prisma.batchAssignmentTicket.create({ data: { batchId: batch.batchId, ticketId, sortOrder: sortOrder++ } });
    }
    return batch.batchId;
  };

  const escalationsFor = (ticketId: string) =>
    prisma.intradayInsertion.findMany({ where: { ticketId, status: 'ESCALATION_REQUIRED' } });

  const zmNotifications = () =>
    prisma.notification.findMany({ where: { recipientUserId: zmUserId }, orderBy: { createdAt: 'desc' } });

  /** Approve leave for today through the real workflow — the trigger AC1 names. */
  const approveLeaveToday = async (seId: string): Promise<void> => {
    const submitted = await leave.submit(
      { seId, type: 'ON_LEAVE', windowStart: NOW, windowEnd: new Date(NOW.getTime() + 12 * 60 * 60_000) },
      zmActor(),
    );
    if (submitted.result !== 'OK') throw new Error(`submit failed: ${submitted.result}`);
    const approved = await leave.approve(submitted.id, zmActor(), NOW);
    if (approved.result !== 'OK') throw new Error(`approve failed: ${approved.result}`);
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    availability = new SeAvailabilityService(prisma);
    leave = new LeaveRequestService(prisma, availability);
    cockpit = new DispatchTodayQueryService(prisma);
    override = new OverrideService(prisma, new AuditService(prisma), new LoggingDayPlanNotifier());
    intraday = new IntradayInsertionService(
      prisma,
      new CandidateSelectionService(prisma),
      override,
      new NotificationService(prisma),
      availability,
      new AuditService(prisma),
    );

    const zm = await prisma.user.create({
      data: { name: 'ZM ' + NS, role: 'ZONAL_MANAGER', phone: 'zm-sw-' + NS, email: `zm-sw-${NS}@sw.test` },
    });
    zmUserId = zm.userId;
    userIds.push(zm.userId);
    zoneId = (await prisma.zone.create({ data: { name: 'Z-sw-' + NS, zonalManagerUserId: zm.userId } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-sw-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-sw-' + NS, zoneId } })).plantId;
  });

  afterEach(async () => {
    await prisma.intradayInsertion.deleteMany({ where: { zoneId } });
    const schedules = await prisma.workSchedule.findMany({ where: { zoneId }, select: { scheduleId: true } });
    const batches = await prisma.plantBatchAssignment.findMany({
      where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } },
      select: { batchId: true },
    });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } } });
    await prisma.workSchedule.deleteMany({ where: { zoneId } });
    await prisma.notification.deleteMany({ where: { recipientUserId: { in: userIds } } });
    await prisma.leaveRequest.deleteMany({ where: { seId: { in: userIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seAvailability.deleteMany({ where: { seId: { in: userIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds.filter((id) => id !== zmUserId) } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds.filter((id) => id !== zmUserId) } } });
    ticketIds.length = 0;
    deviceIds.length = 0;
    userIds.length = 1; // keep the ZM
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { userId: zmUserId } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('AC1 — approving leave that covers today escalates the remaining work and tells the ZM', async () => {
    const se = await makeSe();
    const t1 = await makeTicket();
    const t2 = await makeTicket();
    await givePlan(se, [t1, t2]);

    await approveLeaveToday(se);

    expect(await escalationsFor(t1)).toHaveLength(1);
    expect(await escalationsFor(t2)).toHaveLength(1);

    const notes = await zmNotifications();
    expect(notes).toHaveLength(1);
    expect(notes[0].body ?? '').toContain('2');
  });

  it('AC2 — work already done or already off the plan is not escalated', async () => {
    const se = await makeSe();
    const open = await makeTicket();
    const submitted = await makeTicket('SUBMITTED');
    const removed = await makeTicket();
    const batchId = await givePlan(se, [open, submitted, removed]);
    await prisma.batchAssignmentTicket.updateMany({
      where: { batchId, ticketId: removed },
      data: { removedAt: NOW, removalReason: 'ZM_REMOVED' },
    });

    await approveLeaveToday(se);

    expect(await escalationsFor(open)).toHaveLength(1);
    // Submitted work has been done; a removed row is no longer on anybody's day.
    expect(await escalationsFor(submitted)).toHaveLength(0);
    expect(await escalationsFor(removed)).toHaveLength(0);
    expect((await zmNotifications())[0].body ?? '').toContain('1 committed ticket ');
  });

  it('AC3 — nothing is reassigned: the plan and its assignment rows are exactly as they were', async () => {
    const se = await makeSe();
    const t1 = await makeTicket();
    const batchId = await givePlan(se, [t1]);
    const before = await prisma.batchAssignmentTicket.findFirstOrThrow({ where: { batchId, ticketId: t1 } });

    await approveLeaveToday(se);

    const after = await prisma.batchAssignmentTicket.findFirstOrThrow({ where: { batchId, ticketId: t1 } });
    expect(after).toEqual(before);
    const batch = await prisma.plantBatchAssignment.findUniqueOrThrow({ where: { batchId } });
    expect(batch.seId).toBe(se);
    expect(batch.status).toBe('AUTO_ASSIGNED');
    const schedule = await prisma.workSchedule.findUniqueOrThrow({ where: { scheduleId: batch.scheduleId } });
    expect(schedule.status).toBe('ACTIVE');
    // The ticket is still this engineer's, formally — the escalation asks a human to decide, it does
    // not decide. An unassigned ticket would have silently rewritten the day the operator kept.
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: t1 } });
    expect(ticket.assignmentState).toBe('FORMALLY_ASSIGNED');
  });

  it('AC4 — a second unavailability write does not re-escalate or re-alert', async () => {
    const se = await makeSe();
    const t1 = await makeTicket();
    await givePlan(se, [t1]);

    await approveLeaveToday(se);
    // The manager edits the window an hour later; the ZM already knows about this ticket.
    const second = await availability.setAvailability(
      { seId: se, status: 'ON_LEAVE', windowStart: NOW, windowEnd: null, reason: 'extended' },
      zmActor(),
      NOW,
    );
    expect(second.result).toBe('OK');

    expect(await escalationsFor(t1)).toHaveLength(1);
    expect(await zmNotifications()).toHaveLength(1);
  });

  it('AC5 — the escalation names the engineer the work is stranded on, because that is where it is resolved', async () => {
    const se = await makeSe();
    const t1 = await makeTicket();
    await givePlan(se, [t1]);

    await approveLeaveToday(se);

    const queue = await intraday.listForScope({ role: 'ZONAL_MANAGER', zoneId: Number(zoneId) });
    const row = queue.rows.find((r) => r.ticketId === t1);
    expect(row).toBeTruthy();
    expect(row!.insertionType).toBe('SE_UNAVAILABLE');
    // The queue's own Assign button cannot resolve this row: the ticket is still formally assigned
    // (AC3), and `assignTicket` refuses an assigned ticket rather than silently stealing it. So the
    // row has to say who holds it — the redistribute happens on that engineer's day plan, through the
    // override path a manager already uses (and, since #289, previews).
    expect(row!.assignedSeId).toBe(se);
    expect(row!.assignedSeName).toBeTruthy();

    const dead = await intraday.manualAssign(
      BigInt(row!.insertionId),
      await makeSe(),
      { userId: zmUserId, role: 'ZONAL_MANAGER' },
      { role: 'ZONAL_MANAGER', zoneId: Number(zoneId) },
      NOW,
    );
    expect(dead.result).toBe('ALREADY_ASSIGNED');
  });

  it('does not escalate for leave that starts after today, or for a window that gives the day back', async () => {
    const se = await makeSe();
    const t1 = await makeTicket();
    await givePlan(se, [t1]);

    const nextWeek = new Date(NOW.getTime() + 7 * 24 * 60 * 60_000);
    const future = await availability.setAvailability(
      { seId: se, status: 'ON_LEAVE', windowStart: nextWeek, windowEnd: new Date(nextWeek.getTime() + 86_400_000) },
      zmActor(),
      NOW,
    );
    expect(future.result).toBe('OK');
    expect(await escalationsFor(t1)).toHaveLength(0);

    const back = await availability.setAvailability({ seId: se, status: 'AVAILABLE', windowStart: NOW }, zmActor(), NOW);
    expect(back.result).toBe('OK');
    expect(await escalationsFor(t1)).toHaveLength(0);
    expect(await zmNotifications()).toHaveLength(0);
  });

  it('the cockpit strip can tell this escalation from a capacity one, and says who holds the work', async () => {
    const se = await makeSe();
    const t1 = await makeTicket();
    await givePlan(se, [t1]);

    await approveLeaveToday(se);

    const view = await cockpit.today({ role: 'ZONAL_MANAGER', zoneId: Number(zoneId) }, { zoneId, now: NOW });
    const row = view.escalations.find((e) => e.ticketId === t1);
    expect(row).toBeTruthy();
    // The strip's copy asserts a cause ("no capacity-eligible engineer was available"). It can only
    // keep asserting it if it can see which rows it is true of.
    expect(row!.insertionType).toBe('SE_UNAVAILABLE');
    expect(row!.assignedSeId).toBe(se);
  });

  it('the escalation closes when a human actually moves the work', async () => {
    const se = await makeSe();
    const rescuer = await makeSe();
    const t1 = await makeTicket();
    const batchId = await givePlan(se, [t1]);

    await approveLeaveToday(se);
    expect(await escalationsFor(t1)).toHaveLength(1);

    const moved = await override.override(
      batchId,
      { action: 'REASSIGN', ticketId: t1, newSeId: rescuer, reasonCode: 'ramesh on leave' },
      { role: 'ZONAL_MANAGER', zoneId: Number(zoneId) },
      { userId: zmUserId, role: 'ZONAL_MANAGER' },
      NOW,
    );
    expect(moved.result).toBe('OK');

    // Otherwise the queue and the cockpit strip would keep asking a manager to decide something they
    // have already decided — and the re-escalation guard would key on a row nobody can clear.
    expect(await escalationsFor(t1)).toHaveLength(0);
  });

  /**
   * #356 AC4 (absorbing #331 AC1), the second of the two silent-return sites.
   *
   * This one is the worse of the pair. `escalateStrandedWork` writes a ledger row per stranded ticket
   * **and** #288's re-escalation guard, which keys on those rows — so on a zone with no designated ZM
   * the old code created the "a human already knows" marker for work no human had been told about, and
   * then refused to escalate it again on the next availability write. The day's work went quiet in a
   * way nothing could reopen.
   */
  it('#356 AC4 — a zone that names no ZM alerts the role holders in the zone, never returns silently', async () => {
    const standIn = await prisma.user.create({
      data: { name: 'ZM stand-in ' + NS, role: 'ZONAL_MANAGER', phone: 'zmsi-sw-' + NS, email: `zmsi-sw-${NS}@sw.test`, zoneId },
    });
    userIds.push(standIn.userId);
    await prisma.zone.update({ where: { zoneId }, data: { zonalManagerUserId: null } });
    try {
      const se = await makeSe();
      const t1 = await makeTicket();
      const t2 = await makeTicket();
      await givePlan(se, [t1, t2]);

      await approveLeaveToday(se);

      expect(await escalationsFor(t1)).toHaveLength(1);
      const notes = await prisma.notification.findMany({ where: { recipientUserId: standIn.userId } });
      expect(notes).toHaveLength(1);
      expect(notes[0].type).toBe('INTRADAY_ESCALATION_REQUIRED');
      expect(notes[0].body ?? '').toContain('2');
      // The designated ZM is not told twice — they are not the recipient at all here.
      expect(await zmNotifications()).toHaveLength(0);
    } finally {
      await prisma.zone.update({ where: { zoneId }, data: { zonalManagerUserId: zmUserId } });
    }
  });
});
