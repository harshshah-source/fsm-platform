import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import { SeAvailabilityService } from '../src/engineers/se-availability.service';
import { IntradayInsertionService } from '../src/intraday/intraday-insertion.service';
import { NotificationService } from '../src/notifications/notification.service';
import { PlantEligibleFloatingSeService } from '../src/org/plant-eligible-floating-se.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { LoggingDayPlanNotifier } from '../src/scheduling/day-plan-notifier';
import { OverrideService } from '../src/scheduling/override.service';

/**
 * Issues 29 + 30, retired to direct assignment by #268 (Decision #258 Q3 + Q2). A CRITICAL/HIGH_CRITICAL
 * ticket is assigned directly to the best eligible SE — hard eligibility (availability, capacity as an
 * automatic constraint) → coverage tier → score, the SAME `chooseWithinTier` discipline the morning
 * batch uses — and lands at the top of that SE's Day Plan. No offer, no accept/decline, no timeout.
 * Every eligible candidate at capacity escalates to the ZM (Q-B); there is no automatic capacity bypass.
 */
const NS = Date.now();
const BASE = new Date('2026-06-28T06:00:00Z');

describe('#268 — CRITICAL direct assignment', () => {
  let prisma: PrismaService;
  let svc: IntradayInsertionService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let zmUserId: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];

  const makeSe = async (opts: { dailyCapacity?: number } = {}): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@iq.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({
      data: { engineerId: u.userId, coverageType: 'DEDICATED', zoneId, dailyCapacity: opts.dailyCapacity ?? 10 },
    });
    await prisma.seCoverage.create({ data: { seId: u.userId, plantId, coverageType: 'DEDICATED' } });
    return u.userId;
  };

  const makeCriticalTicket = async (bucket: 'CRITICAL' | 'HIGH_CRITICAL' = 'CRITICAL'): Promise<string> => {
    const deviceId = String(11_700_000_000 + ((NS + deviceIds.length) % 100_000) + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        slaBucket: bucket,
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

  const latestInsertion = (ticketId: string) =>
    prisma.intradayInsertion.findFirstOrThrow({ where: { ticketId }, orderBy: { insertionId: 'desc' } });

  const liveStop = (ticketId: string) =>
    prisma.batchAssignmentTicket.findFirst({ where: { ticketId, removedAt: null }, include: { batch: true } });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new IntradayInsertionService(
      prisma,
      new CandidateSelectionService(prisma),
      new OverrideService(prisma, new AuditService(prisma), new LoggingDayPlanNotifier()),
      new NotificationService(prisma),
      new SeAvailabilityService(prisma),
      new AuditService(prisma),
    );

    const zm = await prisma.user.create({
      data: { name: 'ZM ' + NS, role: 'ZONAL_MANAGER', phone: 'zm-' + NS, email: `zm-${NS}@iq.test` },
    });
    zmUserId = zm.userId;
    userIds.push(zm.userId);
    zoneId = (await prisma.zone.create({ data: { name: 'Z-iq-' + NS, zonalManagerUserId: zm.userId } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-iq-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-iq-' + NS, zoneId } })).plantId;
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
    await prisma.auditLog.deleteMany({
      where: { entityType: { in: ['intraday_insertion', 'ticket', 'failure_cycles'] }, entityId: { in: [...ticketIds] } },
    });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seCoverage.deleteMany({ where: { plantId } });
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

  it('AC-1 — a CRITICAL ticket is assigned within one sweep tick, no acceptance state ever created, at stop 1', async () => {
    const se = await makeSe();
    const ticketId = await makeCriticalTicket();

    const outcome = await svc.assignCriticalForZone(zoneId, BASE);
    expect(outcome).toEqual({ assigned: 1, escalated: 0 });

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    expect(ticket.assignmentState).toBe('FORMALLY_ASSIGNED');

    const ins = await latestInsertion(ticketId);
    expect(ins.status).toBe('ASSIGNED_DIRECT');
    expect(ins.offeredSeId).toBe(se);
    // Never PENDING_ACCEPTANCE at any point — this row was created ASSIGNED_DIRECT from the start.
    expect(ins.retryCount).toBe(0);

    const stop = await liveStop(ticketId);
    expect(stop).not.toBeNull();
    expect(stop!.batch.stopSequence).toBe(1);
    expect(stop!.batch.seId).toBe(se);
  });

  it('AC-2 — tier precedence beats score: an eligible DEDICATED SE wins over a higher-scoring FLOATING one', async () => {
    const dedicated = await makeSe();
    // A floating SE covering the same plant via the MV-backed leg — same fixture shape
    // `candidate-selection.e2e-spec.ts` uses.
    const floatingTag = randomUUID().slice(0, 8);
    const floating = (
      await prisma.user.create({
        data: { name: 'SE ' + floatingTag, role: 'SERVICE_ENGINEER', phone: 'ph-' + floatingTag, email: `${floatingTag}@iq.test`, zoneId },
      })
    ).userId;
    userIds.push(floating);
    await prisma.engineerMaster.create({ data: { engineerId: floating, coverageType: 'FLOATING', zoneId, dailyCapacity: 10 } });
    const district = await prisma.district.create({ data: { name: 'D-iq-' + NS, state: 'IqState-' + NS } });
    await prisma.plant.update({ where: { plantId }, data: { districtId: district.districtId } });
    await prisma.engineerTerritoryCoverage.create({ data: { seId: floating, districtId: district.districtId } });
    const mv = new PlantEligibleFloatingSeService(prisma);
    await mv.refresh();

    const ticketId = await makeCriticalTicket();
    const outcome = await svc.assignCriticalForZone(zoneId, BASE);
    expect(outcome.assigned).toBe(1);

    const ins = await latestInsertion(ticketId);
    // Dedicated wins by tier — regardless of how the shared scorer would rank them within a tier.
    expect(ins.offeredSeId).toBe(dedicated);

    // Cleanup local to this test — the district/territory fixture is not part of the shared afterEach.
    await prisma.engineerTerritoryCoverage.deleteMany({ where: { seId: floating } });
    await prisma.plant.update({ where: { plantId }, data: { districtId: null } });
    await prisma.district.deleteMany({ where: { districtId: district.districtId } });
    await mv.refresh();
  });

  it('AC-2 — skips an unavailable SE and an at-capacity SE, assigning the one eligible candidate', async () => {
    const unavailable = await makeSe();
    await prisma.seAvailability.create({
      data: { seId: unavailable, status: 'SOFT_UNAVAILABLE', windowStart: new Date(BASE.getTime() - 3_600_000), windowEnd: null },
    });
    const atCapacity = await makeSe({ dailyCapacity: 1 });
    // Pre-fill atCapacity's day so committedDayLoad already reads 1/1.
    const schedule = await prisma.workSchedule.create({
      data: { seId: atCapacity, zoneId, dateFrom: new Date('2026-06-28'), dateTo: new Date('2026-06-28'), status: 'ACTIVE', dispatchedAt: BASE },
    });
    const filler = await makeCriticalTicket();
    const fillBatch = await prisma.plantBatchAssignment.create({
      data: { scheduleId: schedule.scheduleId, plantId, seId: atCapacity, status: 'AUTO_ASSIGNED', stopSequence: 1 },
    });
    await prisma.batchAssignmentTicket.create({ data: { batchId: fillBatch.batchId, ticketId: filler, sortOrder: 1 } });
    await prisma.ticket.update({ where: { ticketId: filler }, data: { assignmentState: 'FORMALLY_ASSIGNED' } });

    const eligible = await makeSe();
    const ticketId = await makeCriticalTicket();

    const outcome = await svc.assignCriticalForZone(zoneId, BASE);
    expect(outcome.assigned).toBe(1);

    const ins = await latestInsertion(ticketId);
    expect(ins.offeredSeId).toBe(eligible);
  });

  it('AC-3 (Q-B) — every eligible SE at capacity: NOT auto-assigned, ESCALATION_REQUIRED + ZM alert, then the ZM overrides capacity freely', async () => {
    const se = await makeSe({ dailyCapacity: 1 });
    const schedule = await prisma.workSchedule.create({
      data: { seId: se, zoneId, dateFrom: new Date('2026-06-28'), dateTo: new Date('2026-06-28'), status: 'ACTIVE', dispatchedAt: BASE },
    });
    const filler = await makeCriticalTicket();
    const fillBatch = await prisma.plantBatchAssignment.create({
      data: { scheduleId: schedule.scheduleId, plantId, seId: se, status: 'AUTO_ASSIGNED', stopSequence: 1 },
    });
    await prisma.batchAssignmentTicket.create({ data: { batchId: fillBatch.batchId, ticketId: filler, sortOrder: 1 } });
    await prisma.ticket.update({ where: { ticketId: filler }, data: { assignmentState: 'FORMALLY_ASSIGNED' } });

    const ticketId = await makeCriticalTicket();

    const outcome = await svc.assignCriticalForZone(zoneId, BASE);
    expect(outcome).toEqual({ assigned: 0, escalated: 1 });

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    expect(ticket.assignmentState).toBe('UNASSIGNED'); // not auto-assigned to anyone

    const ins = await latestInsertion(ticketId);
    expect(ins.status).toBe('ESCALATION_REQUIRED');
    expect(ins.offeredSeId).toBeNull();
    expect(ins.acceptanceDeadline).toBeNull();

    // The ZM alert fired.
    const alert = await prisma.notification.findFirst({
      where: { recipientUserId: zmUserId, type: 'INTRADAY_ESCALATION_REQUIRED', entityId: ticketId },
    });
    expect(alert).not.toBeNull();

    // The queue itself is the other half of "operationally visible".
    const queue = await svc.listForScope({ role: 'ZONAL_MANAGER', zoneId: Number(zoneId) });
    expect(queue.some((r) => r.ticketId === ticketId && r.status === 'ESCALATION_REQUIRED')).toBe(true);

    // Q2 — the ZM's administrative right: manualAssign succeeds and pushes `se` past capacity, no
    // block, no forced confirm.
    const manual = await svc.manualAssign(
      ins.insertionId,
      se,
      { userId: zmUserId, role: 'ZONAL_MANAGER' },
      { role: 'ZONAL_MANAGER', zoneId: Number(zoneId) },
      BASE,
    );
    expect(manual.result).toBe('OK');
    const after = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    expect(after.assignmentState).toBe('FORMALLY_ASSIGNED');
  });

  it('AC-4 — capacity map exhausted: zero new batch_assignment_tickets rows written by the sweep (negative assert)', async () => {
    const se = await makeSe({ dailyCapacity: 1 });
    const schedule = await prisma.workSchedule.create({
      data: { seId: se, zoneId, dateFrom: new Date('2026-06-28'), dateTo: new Date('2026-06-28'), status: 'ACTIVE', dispatchedAt: BASE },
    });
    const filler = await makeCriticalTicket();
    const fillBatch = await prisma.plantBatchAssignment.create({
      data: { scheduleId: schedule.scheduleId, plantId, seId: se, status: 'AUTO_ASSIGNED', stopSequence: 1 },
    });
    await prisma.batchAssignmentTicket.create({ data: { batchId: fillBatch.batchId, ticketId: filler, sortOrder: 1 } });
    await prisma.ticket.update({ where: { ticketId: filler }, data: { assignmentState: 'FORMALLY_ASSIGNED' } });

    const before = await prisma.batchAssignmentTicket.count({ where: { removedAt: null, batch: { seId: se } } });
    expect(before).toBe(1); // the filler only

    await makeCriticalTicket();
    await makeCriticalTicket();
    await svc.assignCriticalForZone(zoneId, BASE);

    const after = await prisma.batchAssignmentTicket.count({ where: { removedAt: null, batch: { seId: se } } });
    expect(after).toBe(1); // unchanged — no new stop landed on the over-capacity SE
  });

  it('AC-6 — a deferred CRITICAL ticket is never system-assigned', async () => {
    const se = await makeSe();
    const ticketId = await makeCriticalTicket();
    await prisma.ticket.update({
      where: { ticketId },
      data: { deferredUntil: new Date(BASE.getTime() + 5 * 86_400_000) },
    });

    const outcome = await svc.assignCriticalForZone(zoneId, BASE);
    expect(outcome).toEqual({ assigned: 0, escalated: 0 });

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    expect(ticket.assignmentState).toBe('UNASSIGNED');
    void se;
  });

  it('AC-7 — N criticals spread across eligible SEs by capacity instead of stacking on the first candidate', async () => {
    const seA = await makeSe({ dailyCapacity: 1 });
    const seB = await makeSe({ dailyCapacity: 1 });
    const t1 = await makeCriticalTicket();
    const t2 = await makeCriticalTicket();

    const outcome = await svc.assignCriticalForZone(zoneId, BASE);
    expect(outcome).toEqual({ assigned: 2, escalated: 0 });

    const ins1 = await latestInsertion(t1);
    const ins2 = await latestInsertion(t2);
    const winners = [ins1.offeredSeId, ins2.offeredSeId].sort();
    expect(winners).toEqual([seA, seB].sort());
  });

  it('a ticket already escalated is not re-escalated (and the ZM is not re-alerted) on the next tick', async () => {
    const se = await makeSe({ dailyCapacity: 1 });
    const schedule = await prisma.workSchedule.create({
      data: { seId: se, zoneId, dateFrom: new Date('2026-06-28'), dateTo: new Date('2026-06-28'), status: 'ACTIVE', dispatchedAt: BASE },
    });
    const filler = await makeCriticalTicket();
    const fillBatch = await prisma.plantBatchAssignment.create({
      data: { scheduleId: schedule.scheduleId, plantId, seId: se, status: 'AUTO_ASSIGNED', stopSequence: 1 },
    });
    await prisma.batchAssignmentTicket.create({ data: { batchId: fillBatch.batchId, ticketId: filler, sortOrder: 1 } });
    await prisma.ticket.update({ where: { ticketId: filler }, data: { assignmentState: 'FORMALLY_ASSIGNED' } });

    const ticketId = await makeCriticalTicket();
    const first = await svc.assignCriticalForZone(zoneId, BASE);
    expect(first).toEqual({ assigned: 0, escalated: 1 });

    const second = await svc.assignCriticalForZone(zoneId, new Date(BASE.getTime() + 2 * 60_000));
    expect(second).toEqual({ assigned: 0, escalated: 0 });

    const rows = await prisma.intradayInsertion.findMany({ where: { ticketId } });
    expect(rows).toHaveLength(1); // one escalation row, not two
    void ticketId;
  });

  it('HIGH_CRITICAL is trigger-eligible exactly like CRITICAL', async () => {
    const se = await makeSe();
    const ticketId = await makeCriticalTicket('HIGH_CRITICAL');
    const outcome = await svc.assignCriticalForZone(zoneId, BASE);
    expect(outcome.assigned).toBe(1);
    const ins = await latestInsertion(ticketId);
    expect(ins.offeredSeId).toBe(se);
    expect(ins.slaBucket).toBe('HIGH_CRITICAL');
  });

  it('escalation audit: the CRITICAL_ASSIGN audit row on a direct-assign is stamped SYSTEM, not a human', async () => {
    await makeSe();
    const ticketId = await makeCriticalTicket();
    await svc.assignCriticalForZone(zoneId, BASE);

    const audit = await prisma.auditLog.findFirst({
      where: { entityType: 'ticket', entityId: ticketId, action: 'CRITICAL_ASSIGN' },
    });
    expect(audit?.actorId).toBe('SYSTEM');
    expect(audit?.actorRole).toBe('SYSTEM');
  });
});
