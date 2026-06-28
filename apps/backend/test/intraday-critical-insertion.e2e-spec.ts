import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import { SeAvailabilityService } from '../src/engineers/se-availability.service';
import {
  ACCEPTANCE_TIMEOUT_MIN,
  IntradayInsertionService,
} from '../src/intraday/intraday-insertion.service';
import { NotificationService } from '../src/notifications/notification.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { LoggingDayPlanNotifier } from '../src/scheduling/day-plan-notifier';
import { OverrideService } from '../src/scheduling/override.service';

/**
 * Issues 29 + 30 — system-triggered intra-day CRITICAL insertion + SE Accept/Decline + WhatsApp, and the
 * 10-min timeout reroute chain + 3-retry escalation. The offer engine: best available candidate (strict
 * coverage precedence), Accept commits the Formal Assignment at the top of the Day Plan + first-class
 * WhatsApp, Decline (reason code) and the timeout sweep both reroute, and after 3 retries it escalates.
 */
const NS = Date.now();
const BASE = new Date('2026-06-28T06:00:00Z');
const afterDeadline = (offeredAt: Date) => new Date(offeredAt.getTime() + (ACCEPTANCE_TIMEOUT_MIN + 1) * 60_000);

describe('Issue 29/30 — intra-day CRITICAL insertion + accept/decline + timeout/escalation', () => {
  let prisma: PrismaService;
  let svc: IntradayInsertionService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let zmUserId: string;
  let ses: string[] = [];
  let sortedSes: string[] = [];
  const userIds: string[] = [];
  const deviceIds: bigint[] = [];
  const ticketIds: string[] = [];

  const makeSe = async (): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@iq.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({ data: { engineerId: u.userId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
    await prisma.seCoverage.create({ data: { seId: u.userId, plantId, coverageType: 'DEDICATED' } });
    return u.userId;
  };

  const makeCriticalTicket = async (bucket: 'CRITICAL' | 'HIGH_CRITICAL' = 'CRITICAL'): Promise<string> => {
    const deviceId = BigInt(11_700_000_000 + ((NS + deviceIds.length) % 100_000) + deviceIds.length);
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

    ses = [];
    for (let i = 0; i < 5; i++) ses.push(await makeSe());
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

  // ---- Issue 29 ----------------------------------------------------------

  it('AC#1 fires an offer to the best available candidate (strict precedence) for a CRITICAL ticket', async () => {
    const ticketId = await makeCriticalTicket('CRITICAL');
    const res = await svc.fireForZone(zoneId, BASE);
    expect(res.offered).toBeGreaterThanOrEqual(1);

    const ins = await latestInsertion(ticketId);
    expect(ins.status).toBe('PENDING_ACCEPTANCE');
    expect(ins.offeredSeId).toBe(sortedSes[0]);
    expect(ins.insertionType).toBe('SYSTEM_CRITICAL');
    expect(ins.slaBucket).toBe('CRITICAL');
    expect(ins.acceptanceDeadline.getTime()).toBe(BASE.getTime() + ACCEPTANCE_TIMEOUT_MIN * 60_000);
  });

  it('AC#2 delivers an in-app push carrying Accept/Decline quick actions', async () => {
    const ticketId = await makeCriticalTicket('HIGH_CRITICAL');
    await svc.fireForZone(zoneId, BASE);
    const ins = await latestInsertion(ticketId);

    const push = await prisma.notification.findFirstOrThrow({
      where: { recipientUserId: ins.offeredSeId, type: 'INTRADAY_CRITICAL_OFFER', entityId: ticketId },
    });
    expect((push.metadata as { actions: string[] }).actions).toEqual(['ACCEPT', 'DECLINE']);
    const inApp = await prisma.notificationDelivery.findFirst({ where: { notificationId: push.id, channel: 'IN_APP' } });
    expect(inApp?.status).toBe('SENT');
  });

  it('AC#3+#4 Accept commits the Formal Assignment at the top of the Day Plan + first-class WhatsApp', async () => {
    const ticketId = await makeCriticalTicket('CRITICAL');
    await svc.fireForZone(zoneId, BASE);
    const ins = await latestInsertion(ticketId);

    const out = await svc.accept(ins.insertionId, ins.offeredSeId, BASE);
    expect(out.result).toBe('OK');

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    expect(ticket.assignmentState).toBe('FORMALLY_ASSIGNED');

    const after = await prisma.intradayInsertion.findUniqueOrThrow({ where: { insertionId: ins.insertionId } });
    expect(after.status).toBe('ACCEPTED');
    expect(after.whatsappSentAt).not.toBeNull();

    // Top of Day Plan: the assigned batch leads at stopSequence 1.
    const batch = await prisma.plantBatchAssignment.findUniqueOrThrow({ where: { batchId: BigInt(after.assignedBatchId!) } });
    expect(batch.stopSequence).toBe(1);

    // First-class WhatsApp Confirmation recorded SENT.
    const confirm = await prisma.notification.findFirstOrThrow({
      where: { recipientUserId: ins.offeredSeId, type: 'INTRADAY_ACCEPTED_CONFIRMATION', entityId: ticketId },
    });
    const wa = await prisma.notificationDelivery.findFirstOrThrow({ where: { notificationId: confirm.id, channel: 'WHATSAPP' } });
    expect(wa.status).toBe('SENT');
    expect(wa.firstClass).toBe(true);
  });

  it('Accept is idempotent for the same SE (retry returns OK, no double assignment)', async () => {
    const ticketId = await makeCriticalTicket('CRITICAL');
    await svc.fireForZone(zoneId, BASE);
    const ins = await latestInsertion(ticketId);
    const first = await svc.accept(ins.insertionId, ins.offeredSeId, BASE);
    const second = await svc.accept(ins.insertionId, ins.offeredSeId, BASE);
    expect(first.result).toBe('OK');
    expect(second.result).toBe('OK');
    const bats = await prisma.batchAssignmentTicket.findMany({ where: { ticketId, removedAt: null } });
    expect(bats.length).toBe(1);
  });

  it('AC#5 Decline requires a valid reason code and reroutes to the next-best SE', async () => {
    const ticketId = await makeCriticalTicket('CRITICAL');
    await svc.fireForZone(zoneId, BASE);
    const ins = await latestInsertion(ticketId);
    expect(ins.offeredSeId).toBe(sortedSes[0]);

    const bad = await svc.decline(ins.insertionId, ins.offeredSeId, 'NOT_A_CODE', BASE);
    expect(bad.result).toBe('INVALID_REASON');

    const ok = await svc.decline(ins.insertionId, ins.offeredSeId, 'AT_CAPACITY', BASE);
    expect(ok.result).toBe('OK');

    const after = await prisma.intradayInsertion.findUniqueOrThrow({ where: { insertionId: ins.insertionId } });
    expect(after.status).toBe('PENDING_ACCEPTANCE');
    expect(after.offeredSeId).toBe(sortedSes[1]);
    expect(after.retryCount).toBe(1);
    expect((after.retryChain as Array<{ outcome: string; reasonCode: string }>)[0]).toMatchObject({
      outcome: 'DECLINED',
      reasonCode: 'AT_CAPACITY',
    });
  });

  it('AC#6 the Intra-day Queue lists the insertion zone-scoped with its status', async () => {
    const rows = await svc.listForScope({ role: 'ZONAL_MANAGER', zoneId: Number(zoneId) });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.zoneId === String(zoneId))).toBe(true);
    expect(rows.every((r) => r.insertionType === 'SYSTEM_CRITICAL')).toBe(true);
  });

  // ---- Issue 30 ----------------------------------------------------------

  it('AC#1 10-min timeout flips PENDING → reroute to next-best SE per strict precedence', async () => {
    const ticketId = await makeCriticalTicket('CRITICAL');
    await svc.fireForZone(zoneId, BASE);
    const ins = await latestInsertion(ticketId);
    expect(ins.offeredSeId).toBe(sortedSes[0]);

    const swept = await svc.sweepTimeouts(afterDeadline(ins.offeredAt));
    expect(swept.timedOut).toBeGreaterThanOrEqual(1);

    const after = await prisma.intradayInsertion.findUniqueOrThrow({ where: { insertionId: ins.insertionId } });
    expect(after.status).toBe('PENDING_ACCEPTANCE');
    expect(after.offeredSeId).toBe(sortedSes[1]);
    expect((after.retryChain as Array<{ outcome: string }>)[0].outcome).toBe('TIMED_OUT');
  });

  it('AC#3 the timed-out SE gets a ghost-assignment notice on reroute', async () => {
    const ticketId = await makeCriticalTicket('CRITICAL');
    await svc.fireForZone(zoneId, BASE);
    const ins = await latestInsertion(ticketId);
    await svc.sweepTimeouts(afterDeadline(ins.offeredAt));

    const ghost = await prisma.notification.findFirst({
      where: { recipientUserId: ins.offeredSeId, type: 'INTRADAY_GHOST_ASSIGNMENT', entityId: ticketId },
    });
    expect(ghost).not.toBeNull();
  });

  it('AC#2 activity-ping staleness is NOT a candidate filter — a stale-ping SE is still offered', async () => {
    // Null out the best candidate's last activity ping; it must still receive the offer.
    await prisma.engineerMaster.update({ where: { engineerId: sortedSes[0] }, data: { lastActivityAt: null } });
    const ticketId = await makeCriticalTicket('CRITICAL');
    await svc.fireForZone(zoneId, BASE);
    const ins = await latestInsertion(ticketId);
    expect(ins.offeredSeId).toBe(sortedSes[0]);
  });

  it('AC#4 after 3 retries the insertion escalates (ESCALATION_REQUIRED) + ZM "Manual assignment needed"', async () => {
    const ticketId = await makeCriticalTicket('CRITICAL');
    await svc.fireForZone(zoneId, BASE);
    let ins = await latestInsertion(ticketId);

    // Initial offer + 3 reroutes = 4 timeouts; the 4th lands on retryCount=3 → escalate.
    for (let i = 0; i < 4; i++) {
      ins = await prisma.intradayInsertion.findUniqueOrThrow({ where: { insertionId: ins.insertionId } });
      if (ins.status !== 'PENDING_ACCEPTANCE') break;
      await svc.sweepTimeouts(afterDeadline(ins.offeredAt));
    }

    const after = await prisma.intradayInsertion.findUniqueOrThrow({ where: { insertionId: ins.insertionId } });
    expect(after.status).toBe('ESCALATION_REQUIRED');
    expect(after.retryCount).toBe(3);
    expect((after.retryChain as unknown[]).length).toBe(4);

    const alert = await prisma.notification.findFirst({
      where: { recipientUserId: zmUserId, type: 'INTRADAY_ESCALATION_REQUIRED', entityId: ticketId },
    });
    expect(alert).not.toBeNull();
  });

  it('AC#5+#6 manual-assign modal lists AVAILABLE SEs and ZM manual assignment commits', async () => {
    const ticketId = await makeCriticalTicket('CRITICAL');
    await svc.fireForZone(zoneId, BASE);
    let ins = await latestInsertion(ticketId);
    for (let i = 0; i < 4; i++) {
      ins = await prisma.intradayInsertion.findUniqueOrThrow({ where: { insertionId: ins.insertionId } });
      if (ins.status !== 'PENDING_ACCEPTANCE') break;
      await svc.sweepTimeouts(afterDeadline(ins.offeredAt));
    }
    expect((await prisma.intradayInsertion.findUniqueOrThrow({ where: { insertionId: ins.insertionId } })).status).toBe(
      'ESCALATION_REQUIRED',
    );

    const available = await svc.availableSesForManualAssign(ins.insertionId, BASE);
    expect(available.length).toBe(5);

    const chosen = available[2];
    const out = await svc.manualAssign(
      ins.insertionId,
      chosen,
      { userId: zmUserId, role: 'ZONAL_MANAGER' },
      { role: 'ZONAL_MANAGER', zoneId: Number(zoneId) },
      BASE,
    );
    expect(out.result).toBe('OK');
    const after = await prisma.intradayInsertion.findUniqueOrThrow({ where: { insertionId: ins.insertionId } });
    expect(after.status).toBe('ACCEPTED');
    expect(after.offeredSeId).toBe(chosen);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { ticketId } })).assignmentState).toBe('FORMALLY_ASSIGNED');
  });
});
