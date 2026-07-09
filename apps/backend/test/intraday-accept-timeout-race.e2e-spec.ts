import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import { SeAvailabilityService } from '../src/engineers/se-availability.service';
import { ACCEPTANCE_TIMEOUT_MIN, IntradayInsertionService } from '../src/intraday/intraday-insertion.service';
import { NotificationService } from '../src/notifications/notification.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { LoggingDayPlanNotifier } from '../src/scheduling/day-plan-notifier';
import { OverrideService } from '../src/scheduling/override.service';

/**
 * Issue 101 — the intra-day accept-vs-timeout race (audit CRITICAL #3). Once the business sweeps run
 * unattended, `sweepTimeouts` (the 10-min reroute cron) and an SE's Accept can hit the SAME live offer
 * concurrently. Before the guarded transition this let both "win": the ticket committed to timed-out SE A
 * while SE B held a live re-offer, both told the CRITICAL ticket was theirs. The claim-first guard
 * (`transitionOrConflict` on status+offeredSE+retryCount) makes the DB pick exactly one winner.
 */
const NS = Date.now();
const BASE = new Date('2026-06-28T06:00:00Z');
const afterDeadline = (offeredAt: Date) => new Date(offeredAt.getTime() + (ACCEPTANCE_TIMEOUT_MIN + 1) * 60_000);

describe('Issue 101 — intra-day accept vs timeout reroute (guarded transition, one winner)', () => {
  let prisma: PrismaService;
  let svc: IntradayInsertionService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let sortedSes: string[] = [];
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];

  const makeSe = async (): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@r101.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({ data: { engineerId: u.userId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
    await prisma.seCoverage.create({ data: { seId: u.userId, plantId, coverageType: 'DEDICATED' } });
    return u.userId;
  };

  const makeCriticalTicket = async (): Promise<string> => {
    const deviceId = String(11_910_000_000 + ((NS + deviceIds.length) % 100_000) + deviceIds.length);
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

  const latestInsertion = (ticketId: string) =>
    prisma.intradayInsertion.findFirstOrThrow({ where: { ticketId }, orderBy: { insertionId: 'desc' } });
  const activeBatchTickets = (ticketId: string) =>
    prisma.batchAssignmentTicket.findMany({ where: { ticketId, removedAt: null } });

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
      data: { name: 'ZM ' + NS, role: 'ZONAL_MANAGER', phone: 'zm101-' + NS, email: `zm101-${NS}@r101.test` },
    });
    userIds.push(zm.userId);
    zoneId = (await prisma.zone.create({ data: { name: 'Z-r101-' + NS, zonalManagerUserId: zm.userId } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-r101-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-r101-' + NS, zoneId } })).plantId;

    const ses: string[] = [];
    for (let i = 0; i < 3; i++) ses.push(await makeSe());
    sortedSes = [...ses].sort();
  });

  afterAll(async () => {
    await prisma.intradayInsertion.deleteMany({ where: { zoneId } });
    const schedules = await prisma.workSchedule.findMany({ where: { zoneId }, select: { scheduleId: true } });
    const batches = await prisma.plantBatchAssignment.findMany({
      where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } },
      select: { batchId: true },
    });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.workSchedule.deleteMany({ where: { zoneId } });
    await prisma.notification.deleteMany({ where: { recipientUserId: { in: userIds } } });
    await prisma.auditLog.deleteMany({ where: { entityType: { in: ['intraday_insertion', 'ticket'] }, entityId: { in: [...ticketIds] } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seCoverage.deleteMany({ where: { plantId } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.seAvailability.deleteMany({ where: { seId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('accept then a late timeout sweep: the sweep is a NO-OP — an ACCEPTED offer is never rerouted', async () => {
    const ticketId = await makeCriticalTicket();
    await svc.fireForZone(zoneId, BASE);
    const ins = await latestInsertion(ticketId);
    const seA = ins.offeredSeId;
    expect(seA).toBe(sortedSes[0]);

    const accepted = await svc.accept(ins.insertionId, seA, BASE);
    expect(accepted.result).toBe('OK');

    // The 10-min sweep fires after the (now-stale) deadline. It must NOT reroute the accepted offer.
    const swept = await svc.sweepTimeouts(afterDeadline(ins.offeredAt));
    expect(swept.rerouted).toBe(0);
    expect(swept.escalated).toBe(0);

    const after = await prisma.intradayInsertion.findUniqueOrThrow({ where: { insertionId: ins.insertionId } });
    expect(after.status).toBe('ACCEPTED');
    expect(after.offeredSeId).toBe(seA);
    expect(after.retryCount).toBe(0);
    const bats = await activeBatchTickets(ticketId);
    expect(bats.length).toBe(1);
  });

  it('timeout reroute then a late accept by the timed-out SE: accept loses cleanly (NOT_PENDING), no assignment', async () => {
    const ticketId = await makeCriticalTicket();
    await svc.fireForZone(zoneId, BASE);
    const ins = await latestInsertion(ticketId);
    const seA = ins.offeredSeId;

    // Timeout reroutes A → B first.
    const swept = await svc.sweepTimeouts(afterDeadline(ins.offeredAt));
    expect(swept.rerouted).toBe(1);
    const rerouted = await prisma.intradayInsertion.findUniqueOrThrow({ where: { insertionId: ins.insertionId } });
    expect(rerouted.status).toBe('PENDING_ACCEPTANCE');
    expect(rerouted.offeredSeId).toBe(sortedSes[1]);

    // A (whose offer expired and was rerouted to B) taps Accept late — must not commit the ticket to A.
    // A is no longer the offered SE, so the offer-guard rejects it (NOT_OFFERED).
    const lateAccept = await svc.accept(ins.insertionId, seA, afterDeadline(ins.offeredAt));
    expect(lateAccept.result).toBe('NOT_OFFERED');

    const after = await prisma.intradayInsertion.findUniqueOrThrow({ where: { insertionId: ins.insertionId } });
    expect(after.status).toBe('PENDING_ACCEPTANCE');
    expect(after.offeredSeId).toBe(sortedSes[1]);
    const bats = await activeBatchTickets(ticketId);
    expect(bats.length).toBe(0);
  });

  it('concurrent accept + timeout sweep on the same live offer: exactly one winner, never a double assignment', async () => {
    const ticketId = await makeCriticalTicket();
    await svc.fireForZone(zoneId, BASE);
    const ins = await latestInsertion(ticketId);
    const seA = ins.offeredSeId;
    const when = afterDeadline(ins.offeredAt);

    // Fire both at the same instant against the same PENDING offer.
    const [acceptRes] = await Promise.all([
      svc.accept(ins.insertionId, seA, when),
      svc.sweepTimeouts(when),
    ]);

    const after = await prisma.intradayInsertion.findUniqueOrThrow({ where: { insertionId: ins.insertionId } });
    const bats = await activeBatchTickets(ticketId);
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });

    // Invariant regardless of who won the DB race: never a double assignment.
    expect(bats.length).toBeLessThanOrEqual(1);

    if (acceptRes.result === 'OK') {
      // Accept won: committed to A, sweep found nothing to reroute.
      expect(after.status).toBe('ACCEPTED');
      expect(after.offeredSeId).toBe(seA);
      expect(ticket.assignmentState).toBe('FORMALLY_ASSIGNED');
      expect(bats.length).toBe(1);
    } else {
      // Timeout won: rerouted to B, ticket not assigned, A's accept lost cleanly. Depending on interleave,
      // A either read its (now-stale) offer and lost the claim (NOT_PENDING) or read the rerouted offer and
      // was rejected as no longer the offered SE (NOT_OFFERED) — either way it did NOT commit.
      expect(acceptRes.result).not.toBe('OK');
      expect(after.status).toBe('PENDING_ACCEPTANCE');
      expect(after.offeredSeId).toBe(sortedSes[1]);
      expect(bats.length).toBe(0);
    }
  });
});
