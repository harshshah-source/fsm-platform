import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import { CrossZoneEscalationService, type CrossZoneActor } from '../src/cross-zone/cross-zone-escalation.service';
import { NotificationService } from '../src/notifications/notification.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { LoggingDayPlanNotifier } from '../src/scheduling/day-plan-notifier';
import { OverrideService } from '../src/scheduling/override.service';

/**
 * Issue 32 — cross-zone Platinum auto-escalation + ZM manual flag → CSM cross-zone queue. The auto-sweep,
 * the manual Gold/Silver flag, and the CSM/OH Approve (cross-zone assign) / Deny (Ticket stays home) /
 * Defer decisions + the denied-AUTO → Operations-Head re-escalation, with ZM decision notifications.
 */
const NS = Date.now();
const NOW = new Date('2026-06-28T12:00:00Z');
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

describe('Issue 32 — cross-zone escalation (auto + manual flag + decisions)', () => {
  let prisma: PrismaService;
  let svc: CrossZoneEscalationService;

  let homeZoneId: bigint;
  let targetZoneId: bigint;
  let platinumCompanyId: bigint;
  let goldCompanyId: bigint;
  let plantId: bigint;
  let targetSe: string;
  let zmUserId: string;
  let csmUserId: string;
  let ohUserId: string;
  let otherZmUserId: string;

  const userIds: string[] = [];
  const deviceIds: bigint[] = [];
  const ticketIds: string[] = [];

  let ZM: CrossZoneActor;
  let CSM: CrossZoneActor;

  const makeTicket = async (opts: {
    tier: 'PLATINUM' | 'GOLD' | 'SILVER';
    bucket?: 'CRITICAL' | 'RISK' | null;
    ageMin: number;
  }): Promise<string> => {
    const companyId = opts.tier === 'PLATINUM' ? platinumCompanyId : goldCompanyId;
    const deviceId = BigInt(12_800_000_000 + ((NS + deviceIds.length) % 100_000) + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        slaBucket: opts.bucket ?? null,
        eligibleForUptime: true,
        hasOpenFailureCycle: true,
        latestGpsDatetime: minsAgo(opts.ageMin),
        plantId,
        companyId,
        computedAt: NOW,
      },
    });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: minsAgo(opts.ageMin) } });
    const t = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        failureCycleId: cycle.cycleId,
        deviceId,
        plantId,
        companyId,
        companyTier: opts.tier,
        lastStateChangedAt: minsAgo(opts.ageMin),
      },
    });
    ticketIds.push(t.ticketId);
    return t.ticketId;
  };

  const mkUser = async (role: string, zoneId?: bigint): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: `${role} ${tag}`, role: role as never, phone: 'ph-' + tag, email: `${tag}@cz.test`, zoneId: zoneId ?? null },
    });
    userIds.push(u.userId);
    return u.userId;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new CrossZoneEscalationService(
      prisma,
      new OverrideService(prisma, new AuditService(prisma), new LoggingDayPlanNotifier()),
      new NotificationService(prisma),
      new AuditService(prisma),
    );

    zmUserId = await mkUser('ZONAL_MANAGER');
    otherZmUserId = await mkUser('ZONAL_MANAGER');
    csmUserId = await mkUser('CENTRAL_SERVICE_MANAGER');
    ohUserId = await mkUser('OPERATIONS_HEAD');

    homeZoneId = (await prisma.zone.create({ data: { name: 'Z-cz-home-' + NS, zonalManagerUserId: zmUserId } })).zoneId;
    targetZoneId = (await prisma.zone.create({ data: { name: 'Z-cz-target-' + NS } })).zoneId;
    platinumCompanyId = (
      await prisma.company.create({ data: { name: 'Plat-' + NS, companyTier: 'PLATINUM', companyPriorityRank: 'A' } })
    ).companyId;
    goldCompanyId = (
      await prisma.company.create({ data: { name: 'Gold-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-cz-' + NS, zoneId: homeZoneId } })).plantId;

    targetSe = await mkUser('SERVICE_ENGINEER', targetZoneId);
    await prisma.engineerMaster.create({ data: { engineerId: targetSe, coverageType: 'FLOATING', zoneId: targetZoneId, dailyCapacity: 10 } });

    ZM = { userId: zmUserId, role: 'ZONAL_MANAGER', zoneId: Number(homeZoneId) };
    CSM = { userId: csmUserId, role: 'CENTRAL_SERVICE_MANAGER', zoneId: null };
  });

  afterAll(async () => {
    await prisma.crossZoneEscalation.deleteMany({ where: { homeZoneId: { in: [homeZoneId, targetZoneId] } } });
    const schedules = await prisma.workSchedule.findMany({ where: { zoneId: { in: [homeZoneId, targetZoneId] } }, select: { scheduleId: true } });
    const batches = await prisma.plantBatchAssignment.findMany({ where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } }, select: { batchId: true } });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.workSchedule.deleteMany({ where: { zoneId: { in: [homeZoneId, targetZoneId] } } });
    await prisma.notification.deleteMany({ where: { recipientUserId: { in: userIds } } });
    await prisma.auditLog.deleteMany({ where: { entityType: { in: ['cross_zone_escalation', 'ticket'] }, entityId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId: { in: [platinumCompanyId, goldCompanyId] } } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: [homeZoneId, targetZoneId] } } });
    await prisma.onModuleDestroy();
  });

  const escFor = (ticketId: string) =>
    prisma.crossZoneEscalation.findFirstOrThrow({ where: { ticketId }, orderBy: { escalationId: 'desc' } });

  it('AC#1 auto-escalates a Platinum CRITICAL ticket unassigned > 1h; leaves a fresh one', async () => {
    const stale = await makeTicket({ tier: 'PLATINUM', bucket: 'CRITICAL', ageMin: 90 });
    const fresh = await makeTicket({ tier: 'PLATINUM', bucket: 'CRITICAL', ageMin: 20 });

    const res = await svc.sweepAutoEscalations(NOW, homeZoneId);
    expect(res.escalated).toBe(1);

    const esc = await escFor(stale);
    expect(esc.escalationType).toBe('AUTO_PLATINUM');
    expect(esc.status).toBe('PENDING');
    expect(esc.triggerBucket).toBe('CRITICAL');
    expect(esc.raisedByRole).toBe('SYSTEM');
    expect(await prisma.crossZoneEscalation.findFirst({ where: { ticketId: fresh } })).toBeNull();

    // CSM + OH were notified of the new cross-zone queue item.
    const csmNote = await prisma.notification.findFirst({
      where: { recipientUserId: csmUserId, type: 'CROSS_ZONE_AUTO_ESCALATION', entityId: stale },
    });
    expect(csmNote).not.toBeNull();
  });

  it('AC#1 auto-escalates a Platinum ticket OPEN > 4h even below CRITICAL bucket', async () => {
    const t = await makeTicket({ tier: 'PLATINUM', bucket: 'RISK', ageMin: 300 });
    await svc.sweepAutoEscalations(NOW, homeZoneId);
    const esc = await escFor(t);
    expect(esc.status).toBe('PENDING');
    expect(esc.triggerBucket).toBe('RISK');
  });

  it('does not double-escalate a ticket already in the queue', async () => {
    const before = await prisma.crossZoneEscalation.count({ where: { homeZoneId } });
    await svc.sweepAutoEscalations(NOW, homeZoneId);
    const after = await prisma.crossZoneEscalation.count({ where: { homeZoneId } });
    expect(after).toBe(before);
  });

  it('AC#2 ZM manually flags a Gold ticket in own zone with a reason', async () => {
    const t = await makeTicket({ tier: 'GOLD', bucket: 'CRITICAL', ageMin: 30 });
    const out = await svc.flag(t, 'No local SE available today', ZM, NOW);
    expect(out.result).toBe('OK');
    const esc = await escFor(t);
    expect(esc.escalationType).toBe('MANUAL_FLAG');
    expect(esc.flagReason).toBe('No local SE available today');
    expect(esc.companyTier).toBe('GOLD');
  });

  it('AC#2 rejects a manual flag on a Platinum ticket (FORBIDDEN_TIER), out-of-zone (FORBIDDEN_SCOPE), and duplicates', async () => {
    const plat = await makeTicket({ tier: 'PLATINUM', bucket: 'CRITICAL', ageMin: 30 });
    expect((await svc.flag(plat, 'x', ZM, NOW)).result).toBe('FORBIDDEN_TIER');

    const gold = await makeTicket({ tier: 'GOLD', bucket: 'CRITICAL', ageMin: 30 });
    const otherZm: CrossZoneActor = { userId: otherZmUserId, role: 'ZONAL_MANAGER', zoneId: Number(targetZoneId) };
    expect((await svc.flag(gold, 'x', otherZm, NOW)).result).toBe('FORBIDDEN_SCOPE');

    expect((await svc.flag(gold, 'first', ZM, NOW)).result).toBe('OK');
    expect((await svc.flag(gold, 'again', ZM, NOW)).result).toBe('ALREADY_ESCALATED');
  });

  it('AC#3 the cross-zone queue lists actionable rows with the auto/manual split discriminator', async () => {
    const rows = await svc.listForScope({ role: 'CENTRAL_SERVICE_MANAGER', zoneId: null });
    expect(rows.some((r) => r.escalationType === 'AUTO_PLATINUM')).toBe(true);
    expect(rows.some((r) => r.escalationType === 'MANUAL_FLAG')).toBe(true);
    expect(rows.every((r) => ['PENDING', 'DEFERRED', 'ESCALATED_TO_OPS'].includes(r.status))).toBe(true);
  });

  it('AC#4+#6 CSM approves with target zone + SE → cross-zone Formal Assignment + ZM notified', async () => {
    const t = await makeTicket({ tier: 'PLATINUM', bucket: 'CRITICAL', ageMin: 120 });
    await svc.sweepAutoEscalations(NOW, homeZoneId);
    const esc = await escFor(t);

    const out = await svc.approve(esc.escalationId, Number(targetZoneId), targetSe, CSM, NOW);
    expect(out.result).toBe('OK');

    const after = await prisma.crossZoneEscalation.findUniqueOrThrow({ where: { escalationId: esc.escalationId } });
    expect(after.status).toBe('APPROVED');
    expect(after.assignedSeId).toBe(targetSe);
    expect(after.targetZoneId).toBe(targetZoneId);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { ticketId: t } })).assignmentState).toBe('FORMALLY_ASSIGNED');

    const zmNote = await prisma.notification.findFirst({
      where: { recipientUserId: zmUserId, type: 'CROSS_ZONE_DECISION', entityId: t },
    });
    expect(zmNote).not.toBeNull();
  });

  it('AC#4+#5 deny keeps the ticket in its home queue; the home ZM can re-escalate a denied AUTO to Ops Head', async () => {
    const t = await makeTicket({ tier: 'PLATINUM', bucket: 'CRITICAL', ageMin: 120 });
    await svc.sweepAutoEscalations(NOW, homeZoneId);
    const esc = await escFor(t);

    const denied = await svc.deny(esc.escalationId, 'Target zones also at capacity', CSM, NOW);
    expect(denied.result).toBe('OK');
    const afterDeny = await prisma.crossZoneEscalation.findUniqueOrThrow({ where: { escalationId: esc.escalationId } });
    expect(afterDeny.status).toBe('DENIED');
    expect(afterDeny.decisionReason).toBe('Target zones also at capacity');
    // Ticket stays in its home queue — unassigned, OPEN.
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: t } });
    expect(ticket.status).toBe('OPEN');
    expect(ticket.assignmentState).toBe('UNASSIGNED');

    const reEsc = await svc.reEscalateToOps(esc.escalationId, ZM, NOW);
    expect(reEsc.result).toBe('OK');
    expect((await prisma.crossZoneEscalation.findUniqueOrThrow({ where: { escalationId: esc.escalationId } })).status).toBe('ESCALATED_TO_OPS');
    const ohNote = await prisma.notification.findFirst({
      where: { recipientUserId: ohUserId, type: 'CROSS_ZONE_RE_ESCALATED', entityId: t },
    });
    expect(ohNote).not.toBeNull();
  });

  it('AC#4 defer records a review date + reason', async () => {
    const t = await makeTicket({ tier: 'PLATINUM', bucket: 'CRITICAL', ageMin: 120 });
    await svc.sweepAutoEscalations(NOW, homeZoneId);
    const esc = await escFor(t);
    const reviewDate = new Date('2026-06-30T06:00:00Z');
    const out = await svc.defer(esc.escalationId, reviewDate, 'Revisit after morning batch', CSM, NOW);
    expect(out.result).toBe('OK');
    const after = await prisma.crossZoneEscalation.findUniqueOrThrow({ where: { escalationId: esc.escalationId } });
    expect(after.status).toBe('DEFERRED');
    expect(after.reviewDate?.toISOString()).toBe(reviewDate.toISOString());
  });

  it('rejects re-escalating a non-denied or manual escalation (NOT_DENIED_AUTO)', async () => {
    const t = await makeTicket({ tier: 'GOLD', bucket: 'CRITICAL', ageMin: 30 });
    await svc.flag(t, 'manual', ZM, NOW);
    const esc = await escFor(t);
    expect((await svc.reEscalateToOps(esc.escalationId, ZM, NOW)).result).toBe('NOT_DENIED_AUTO');
  });
});
