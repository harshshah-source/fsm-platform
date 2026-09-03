import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import { CrossZoneEscalationService, type CrossZoneActor } from '../src/cross-zone/cross-zone-escalation.service';
import { NotificationService } from '../src/notifications/notification.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { LoggingDayPlanNotifier } from '../src/scheduling/day-plan-notifier';
import { OverrideService } from '../src/scheduling/override.service';
import { NOTIFY_EVENT_TYPE, drainRows } from '../src/scheduling/day-plan-notification-outbox';
import type { NotifyInput } from '../src/notifications/notification.service';
import {
  EnqueueFailed,
  failingNotifyEnqueue,
  inertDayPlanNotifier,
  throwingNotifications,
} from './fixtures/outbox-crash-injection';

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
  let override: OverrideService;

  let homeZoneId: bigint;
  let targetZoneId: bigint;
  let platinumCompanyId: bigint;
  let goldCompanyId: bigint;
  let plantId: bigint;
  /** #354 — a plant in the *target* zone, whose zone has no designated ZM (the AC4 fallback case). */
  let targetPlantId: bigint;
  let targetSe: string;
  let otherSe: string;
  let zmUserId: string;
  let csmUserId: string;
  let ohUserId: string;
  let otherZmUserId: string;
  /** #354 — a ZM of the target zone by `users.zone_id` only; that zone names no `zonalManagerUserId`. */
  let targetZmUserId: string;

  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];

  let ZM: CrossZoneActor;
  let CSM: CrossZoneActor;

  const makeTicket = async (opts: {
    tier: 'PLATINUM' | 'GOLD' | 'SILVER';
    bucket?: 'CRITICAL' | 'RISK' | null;
    ageMin: number;
    /** #354 — which plant (and therefore which home zone) the ticket belongs to. Defaults to the home zone. */
    plant?: bigint;
  }): Promise<string> => {
    const companyId = opts.tier === 'PLATINUM' ? platinumCompanyId : goldCompanyId;
    const plant = opts.plant ?? plantId;
    const deviceId = String(12_800_000_000 + ((NS + deviceIds.length) % 100_000) + deviceIds.length);
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
        plantId: plant,
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
        plantId: plant,
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
    override = new OverrideService(prisma, new AuditService(prisma), new LoggingDayPlanNotifier());
    svc = new CrossZoneEscalationService(prisma, override, new NotificationService(prisma), new AuditService(prisma));

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
    targetPlantId = (await prisma.plant.create({ data: { name: 'P-cz-target-' + NS, zoneId: targetZoneId } })).plantId;

    targetSe = await mkUser('SERVICE_ENGINEER', targetZoneId);
    await prisma.engineerMaster.create({ data: { engineerId: targetSe, coverageType: 'FLOATING', zoneId: targetZoneId, dailyCapacity: 10 } });
    otherSe = await mkUser('SERVICE_ENGINEER', targetZoneId);
    await prisma.engineerMaster.create({ data: { engineerId: otherSe, coverageType: 'FLOATING', zoneId: targetZoneId, dailyCapacity: 10 } });
    // The target zone deliberately names no `zonalManagerUserId`: its ZM is discoverable only by role
    // + `users.zone_id`, which is the fallback #354 AC4 requires and the recipient AC5 needs.
    targetZmUserId = await mkUser('ZONAL_MANAGER', targetZoneId);

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
    await prisma.plant.deleteMany({ where: { plantId: { in: [plantId, targetPlantId] } } });
    await prisma.company.deleteMany({ where: { companyId: { in: [platinumCompanyId, goldCompanyId] } } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: [homeZoneId, targetZoneId] } } });
    await prisma.onModuleDestroy();
    // #354 — this teardown is ~20 statements over two zones and now runs against a fixture that also
    // holds a second plant, a second SE and the assignments the approve tests make. The default 10s
    // hook budget was the binding constraint, not anything the tests do.
  }, 30_000);

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

  /**
   * #338 — the cross-zone notices are durable, and they commit with the escalation they announce.
   *
   * This file's three notify helpers were the last of the twelve post-commit sites, and they were
   * the worst placed: `create` → `audit` → `notify` as three bare awaits (survey CZ-02), so a crash
   * between them left a PENDING cross-zone escalation that no CSM or OH had been told about — a
   * Platinum ticket waiting in a queue nobody was asked to look at. A *throw* in the push abandoned
   * the rest of the sweep's zone.
   *
   * The earlier reading — that AC1 here had to wait for #354 — was too pessimistic. What #354 owns is
   * CZ-01: `approve` writing its escalation update *outside* `assignTicket`'s transaction, which is a
   * cross-service atomicity problem and is untouched here. Each of these doors' own writes are local,
   * and a local transaction is exactly what CZ-02 asks for.
   */
  describe('#338 — the cross-zone notices are written in the escalation transaction', () => {
    const svcOn = (client: PrismaService, notifications = new NotificationService(client)) =>
      new CrossZoneEscalationService(
        client,
        new OverrideService(client, new AuditService(client), inertDayPlanNotifier),
        notifications,
        new AuditService(client),
      );

    const payloadOf = (row: { payload: unknown }): NotifyInput => (row.payload ?? {}) as unknown as NotifyInput;

    const noticesFor = async (ticketId: string) => {
      const rows = await prisma.dayPlanNotificationOutbox.findMany({
        where: { eventType: NOTIFY_EVENT_TYPE },
        orderBy: { id: 'asc' },
      });
      return rows.filter((r) => payloadOf(r).entityId === ticketId);
    };

    it('a notifier that throws leaves the escalation raised and the queue notice retryable', async () => {
      const t = await makeTicket({ tier: 'PLATINUM', bucket: 'CRITICAL', ageMin: 90 });

      // This used to reject, abandoning every later ticket in the zone because one push failed.
      expect((await svcOn(prisma, throwingNotifications()).sweepAutoEscalations(NOW, homeZoneId)).escalated).toBe(1);

      const esc = await escFor(t);
      expect(esc.status).toBe('PENDING');
      expect(await prisma.auditLog.count({ where: { entityId: String(esc.escalationId), action: 'CROSS_ZONE_AUTO_ESCALATION' } })).toBe(1);

      const rows = await noticesFor(t);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(payloadOf(row).type).toBe('CROSS_ZONE_AUTO_ESCALATION');
      expect(payloadOf(row).recipients.map((r) => r.userId)).toEqual(expect.arrayContaining([csmUserId, ohUserId]));
      expect(row.sentAt).toBeNull();
      expect(await prisma.notification.count({ where: { recipientUserId: csmUserId, entityId: t } })).toBe(0);

      await drainRows(prisma, inertDayPlanNotifier, [row.id], NOW, { notify: new NotificationService(prisma) });
      expect(await prisma.notification.count({ where: { recipientUserId: csmUserId, entityId: t } })).toBe(1);
      await drainRows(prisma, inertDayPlanNotifier, [row.id], NOW, { notify: new NotificationService(prisma) });
      expect(await prisma.notification.count({ where: { recipientUserId: csmUserId, entityId: t } })).toBe(1);
      await prisma.dayPlanNotificationOutbox.deleteMany({ where: { id: row.id } });
    });

    it('AC1 — a failed enqueue rolls the auto-escalation back, audit row included', async () => {
      const t = await makeTicket({ tier: 'PLATINUM', bucket: 'CRITICAL', ageMin: 90 });

      // #354 amended the outer behaviour, not the property: the sweep no longer rejects, because its
      // per-ticket catch keeps the rest of the zone moving (AC3). What #338 asserts here is unchanged
      // and is the whole point — nothing of the failed ticket survives the failed enqueue.
      expect((await svcOn(failingNotifyEnqueue(prisma)).sweepAutoEscalations(NOW, homeZoneId)).escalated).toBe(0);

      expect(await prisma.crossZoneEscalation.count({ where: { ticketId: t } })).toBe(0);
      expect(await noticesFor(t)).toHaveLength(0);
    });

    it("AC1 — the ZM's manual flag and its queue notice commit together", async () => {
      const t = await makeTicket({ tier: 'GOLD', bucket: 'CRITICAL', ageMin: 30 });

      await expect(svcOn(failingNotifyEnqueue(prisma)).flag(t, 'manual', ZM, NOW)).rejects.toThrow(EnqueueFailed);

      expect(await prisma.crossZoneEscalation.count({ where: { ticketId: t } })).toBe(0);
      expect(await noticesFor(t)).toHaveLength(0);
    });

    it("AC1 — a decision and the home ZM's notice commit together", async () => {
      const t = await makeTicket({ tier: 'GOLD', bucket: 'CRITICAL', ageMin: 30 });
      await svc.flag(t, 'manual', ZM, NOW);
      const esc = await escFor(t);

      await expect(svcOn(failingNotifyEnqueue(prisma)).deny(esc.escalationId, 'no capacity', CSM, NOW)).rejects.toThrow(
        EnqueueFailed,
      );

      // The escalation is still PENDING: a decision the home ZM was never told about is the state
      // this door must not be able to leave behind.
      const after = await prisma.crossZoneEscalation.findUniqueOrThrow({ where: { escalationId: esc.escalationId } });
      expect(after.status).toBe('PENDING');
      expect(after.decidedAt).toBeNull();
    });
  });

  /**
   * #354 — the approval is one transaction, and the zone that has to do the work is told.
   *
   * #338 gave every cross-zone door its own transaction (CZ-02). What it deliberately left is CZ-01:
   * `approve` committed `assignTicket` in *its* transaction and then updated the escalation in another,
   * so a crash in the gap left an assigned ticket beside a PENDING escalation — and the retry then
   * short-circuited on `ALREADY_ASSIGNED` and could never repair it (#139). The assertions below are on
   * the **mutations** (the ticket's assignment state and the escalation row), never on the notice: that
   * is the only thing that tells one transaction from two.
   */
  describe('#354 — approve is atomic, reconcilable, and tells the target zone', () => {
    const svcOn = (client: PrismaService, notifications = new NotificationService(client)) =>
      new CrossZoneEscalationService(
        client,
        new OverrideService(client, new AuditService(client), inertDayPlanNotifier),
        notifications,
        new AuditService(client),
      );

    /**
     * An enqueue that fails for the notices matching `hits` only — the rest of the transaction, and
     * every *other* ticket's notice, is written normally. `failingNotifyEnqueue` fails them all, which
     * cannot express "one bad ticket in a sweep of several" (AC3).
     */
    const failingNotifyEnqueueWhen = (client: PrismaService, hits: (payload: NotifyInput) => boolean): PrismaService => {
      const wrapDelegate = (delegate: object): object =>
        new Proxy(delegate, {
          get(d, dp) {
            if (dp !== 'create') return Reflect.get(d, dp);
            return async (args: { data?: { eventType?: string; payload?: unknown } }) => {
              if (args?.data?.eventType === NOTIFY_EVENT_TYPE && hits((args.data.payload ?? {}) as NotifyInput)) {
                throw new EnqueueFailed();
              }
              const create = Reflect.get(d, 'create') as (a: unknown) => Promise<unknown>;
              return create.call(d, args);
            };
          },
        });
      const wrapClient = (c: object): object =>
        new Proxy(c, {
          get(target, prop, receiver) {
            if (prop === 'dayPlanNotificationOutbox') return wrapDelegate(Reflect.get(target, prop, receiver) as object);
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
      return wrapClient(client) as PrismaService;
    };

    const escalate = async (opts: { ageMin?: number } = {}): Promise<{ ticketId: string; escalationId: bigint }> => {
      const ticketId = await makeTicket({ tier: 'PLATINUM', bucket: 'CRITICAL', ageMin: opts.ageMin ?? 120 });
      await svc.sweepAutoEscalations(NOW, homeZoneId);
      return { ticketId, escalationId: (await escFor(ticketId)).escalationId };
    };

    const liveBatchRow = (ticketId: string) =>
      prisma.batchAssignmentTicket.findFirst({ where: { ticketId, removedAt: null } });

    it('AC1 — a crash after the assignment rolls the assignment back too; the escalation cannot be left PENDING beside an assigned ticket', async () => {
      const { ticketId, escalationId } = await escalate();

      await expect(
        svcOn(failingNotifyEnqueueWhen(prisma, () => true)).approve(escalationId, Number(targetZoneId), targetSe, CSM, NOW),
      ).rejects.toThrow(EnqueueFailed);

      // The mutation, not the notice: before #354 the assignment had already committed in its own
      // transaction and only the escalation update rolled back — exactly the half-done approval.
      const after = await prisma.crossZoneEscalation.findUniqueOrThrow({ where: { escalationId } });
      expect(after.status).toBe('PENDING');
      expect(after.targetZoneId).toBeNull();
      expect((await prisma.ticket.findUniqueOrThrow({ where: { ticketId } })).assignmentState).toBe('UNASSIGNED');
      expect(await liveBatchRow(ticketId)).toBeNull();
    });

    it('AC2 — a retry after ALREADY_ASSIGNED for the same SE reconciles the escalation to APPROVED', async () => {
      const { ticketId, escalationId } = await escalate();

      // The #139 state: the assignment committed, the escalation update did not.
      const assigned = await override.assignTicket(
        ticketId,
        targetSe,
        { role: 'CENTRAL_SERVICE_MANAGER', zoneId: null },
        CSM,
        NOW,
        'CROSS_ZONE_ASSIGN',
      );
      expect(assigned.result).toBe('OK');

      const out = await svc.approve(escalationId, Number(targetZoneId), targetSe, CSM, NOW);
      expect(out.result).toBe('OK');

      const after = await prisma.crossZoneEscalation.findUniqueOrThrow({ where: { escalationId } });
      expect(after.status).toBe('APPROVED');
      expect(after.assignedSeId).toBe(targetSe);
      expect(after.targetZoneId).toBe(targetZoneId);
      // Reconciled from the live assignment, not invented: the ids name the batch the ticket is on.
      const live = await liveBatchRow(ticketId);
      expect(after.assignedBatchId).toBe(live?.batchId);
      expect(after.decidedByUserId).toBe(csmUserId);
    });

    it('AC2 — an ALREADY_ASSIGNED to a different SE is still a conflict, and leaves the escalation alone', async () => {
      const { ticketId, escalationId } = await escalate();
      await override.assignTicket(ticketId, otherSe, { role: 'CENTRAL_SERVICE_MANAGER', zoneId: null }, CSM, NOW, 'CROSS_ZONE_ASSIGN');

      const out = await svc.approve(escalationId, Number(targetZoneId), targetSe, CSM, NOW);
      expect(out.result).toBe('ALREADY_ASSIGNED');
      expect(out.result === 'ALREADY_ASSIGNED' ? out.assignedSeId : null).toBe(otherSe);
      expect((await prisma.crossZoneEscalation.findUniqueOrThrow({ where: { escalationId } })).status).toBe('PENDING');
    });

    it('AC3 — one ticket whose notice cannot be enqueued neither aborts the sweep nor orphans itself', async () => {
      const good = await makeTicket({ tier: 'PLATINUM', bucket: 'CRITICAL', ageMin: 200 });
      const bad = await makeTicket({ tier: 'PLATINUM', bucket: 'CRITICAL', ageMin: 200 });

      const client = failingNotifyEnqueueWhen(prisma, (p) => p.entityId === bad);
      // Before #354 the whole sweep rejected on the first bad ticket, abandoning the zone's remaining
      // Platinum work — and #140's other half: whatever the failure left behind made the ticket
      // permanently invisible to `crossZoneEscalations: { none: {} }`.
      await expect(svcOn(client).sweepAutoEscalations(NOW, homeZoneId)).resolves.toBeDefined();

      expect(await prisma.crossZoneEscalation.count({ where: { ticketId: good } })).toBe(1);
      expect(await prisma.crossZoneEscalation.count({ where: { ticketId: bad } })).toBe(0);

      // Not orphaned: the next sweep still sees it, because nothing half-written was left behind.
      await svc.sweepAutoEscalations(NOW, homeZoneId);
      expect(await prisma.crossZoneEscalation.count({ where: { ticketId: bad } })).toBe(1);
    });

    it('CZ-13 — a ticket held to a return date is reported as deferred, not as "escalation or SE not found"', async () => {
      const { ticketId, escalationId } = await escalate();
      await prisma.ticket.update({ where: { ticketId }, data: { deferredUntil: new Date('2026-07-10T00:00:00Z') } });

      const out = await svc.approve(escalationId, Number(targetZoneId), targetSe, CSM, NOW);
      expect(out.result).toBe('TICKET_DEFERRED');
      expect((await prisma.crossZoneEscalation.findUniqueOrThrow({ where: { escalationId } })).status).toBe('PENDING');
      expect((await prisma.ticket.findUniqueOrThrow({ where: { ticketId } })).assignmentState).toBe('UNASSIGNED');
    });

    it('CZ-13 — an SE that does not exist is reported as an SE miss, not as a missing escalation', async () => {
      const { escalationId } = await escalate();
      const out = await svc.approve(escalationId, Number(targetZoneId), '00000000-0000-0000-0000-0000000000aa', CSM, NOW);
      expect(out.result).toBe('SE_NOT_FOUND');
    });

    it('AC4 — a home zone with no designated ZM notifies its ZMs by role rather than returning silently', async () => {
      const t = await makeTicket({ tier: 'GOLD', bucket: 'CRITICAL', ageMin: 30, plant: targetPlantId });
      const targetZm: CrossZoneActor = { userId: targetZmUserId, role: 'ZONAL_MANAGER', zoneId: Number(targetZoneId) };
      expect((await svc.flag(t, 'no cover', targetZm, NOW)).result).toBe('OK');
      const esc = await escFor(t);

      expect((await svc.deny(esc.escalationId, 'no capacity anywhere', CSM, NOW)).result).toBe('OK');

      const note = await prisma.notification.findFirst({
        where: { recipientUserId: targetZmUserId, type: 'CROSS_ZONE_DECISION', entityId: t },
      });
      expect(note).not.toBeNull();
    });

    it('AC5 — the target ZM is told CROSS_ZONE_INCOMING and sees the row as incoming in /cross-zone', async () => {
      const { ticketId, escalationId } = await escalate();

      expect((await svc.approve(escalationId, Number(targetZoneId), targetSe, CSM, NOW)).result).toBe('OK');

      const incoming = await prisma.notification.findFirst({
        where: { recipientUserId: targetZmUserId, type: 'CROSS_ZONE_INCOMING', entityId: ticketId },
      });
      expect(incoming).not.toBeNull();

      const targetRows = await svc.listForScope({ role: 'ZONAL_MANAGER', zoneId: Number(targetZoneId) });
      const row = targetRows.find((r) => r.escalationId === String(escalationId));
      expect(row).toBeDefined();
      expect(row?.direction).toBe('incoming');

      // The home ZM's own queue is unchanged in shape: its rows are the work it sent out.
      const homeRows = await svc.listForScope({ role: 'ZONAL_MANAGER', zoneId: Number(homeZoneId) });
      expect(homeRows.every((r) => r.direction === 'outgoing')).toBe(true);
      expect(homeRows.some((r) => r.escalationId === String(escalationId))).toBe(false);
    });
  });

  /**
   * #355 — the four reads and one sweep that turn cross-zone from a set of write doors into a workflow.
   *
   * Each of these is a place work could stop being anyone's: a DENIED AUTO row that vanished from the
   * only queue whose ZM may re-escalate it, an approval whose target zone was never checked against the
   * engineer being assigned, a deferral with a review date nothing ever read, and a decision record
   * with no reader at all.
   */
  describe('#355 — denied-AUTO visibility, SE/zone agreement, due-review resurfacing, history', () => {
    const escalate = async (): Promise<{ ticketId: string; escalationId: bigint }> => {
      const ticketId = await makeTicket({ tier: 'PLATINUM', bucket: 'CRITICAL', ageMin: 120 });
      await svc.sweepAutoEscalations(NOW, homeZoneId);
      return { ticketId, escalationId: (await escFor(ticketId)).escalationId };
    };

    it('AC2 — a denied AUTO escalation stays visible to its home ZM (and only to them) so it can be re-escalated', async () => {
      const { escalationId } = await escalate();
      expect((await svc.deny(escalationId, 'no capacity', CSM, NOW)).result).toBe('OK');

      const homeRows = await svc.listForScope({ role: 'ZONAL_MANAGER', zoneId: Number(homeZoneId) });
      const row = homeRows.find((r) => r.escalationId === String(escalationId));
      expect(row).toBeDefined();
      expect(row?.status).toBe('DENIED');
      expect(row?.direction).toBe('outgoing');
      expect(row?.decisionReason).toBe('no capacity');

      // The CSM/OH queue is what is left to decide; a denied row is not theirs to act on any more.
      const csmRows = await svc.listForScope({ role: 'CENTRAL_SERVICE_MANAGER', zoneId: null });
      expect(csmRows.some((r) => r.escalationId === String(escalationId))).toBe(false);
    });

    it('AC2 — a denied MANUAL flag does not come back: only an AUTO escalation is re-escalatable', async () => {
      const t = await makeTicket({ tier: 'GOLD', bucket: 'CRITICAL', ageMin: 30 });
      await svc.flag(t, 'manual', ZM, NOW);
      const esc = await escFor(t);
      expect((await svc.deny(esc.escalationId, 'no capacity', CSM, NOW)).result).toBe('OK');

      const homeRows = await svc.listForScope({ role: 'ZONAL_MANAGER', zoneId: Number(homeZoneId) });
      expect(homeRows.some((r) => r.escalationId === String(esc.escalationId))).toBe(false);
    });

    it('AC3 — an SE outside the chosen target zone is refused, and nothing is assigned', async () => {
      const { ticketId, escalationId } = await escalate();

      const out = await svc.approve(escalationId, Number(homeZoneId), targetSe, CSM, NOW);
      expect(out.result).toBe('ZONE_SE_MISMATCH');
      expect(out.result === 'ZONE_SE_MISMATCH' ? out.seZoneId : null).toBe(Number(targetZoneId));

      expect((await prisma.crossZoneEscalation.findUniqueOrThrow({ where: { escalationId } })).status).toBe('PENDING');
      expect((await prisma.ticket.findUniqueOrThrow({ where: { ticketId } })).assignmentState).toBe('UNASSIGNED');
    });

    it("AC3 — an approve with no target zone derives it from the SE's own zone", async () => {
      const { escalationId } = await escalate();

      const out = await svc.approve(escalationId, null, targetSe, CSM, NOW);
      expect(out.result).toBe('OK');
      expect((await prisma.crossZoneEscalation.findUniqueOrThrow({ where: { escalationId } })).targetZoneId).toBe(targetZoneId);
    });

    it('AC4 — a deferred escalation returns to PENDING on its review date, with a notice, exactly once', async () => {
      const { ticketId, escalationId } = await escalate();
      const reviewDate = new Date('2026-06-29T06:00:00Z');
      expect((await svc.defer(escalationId, reviewDate, 'revisit after the morning batch', CSM, NOW)).result).toBe('OK');

      const before = new Date('2026-06-29T05:00:00Z');
      expect((await svc.sweepDueReviews(before)).resurfaced).toBe(0);
      expect((await prisma.crossZoneEscalation.findUniqueOrThrow({ where: { escalationId } })).status).toBe('DEFERRED');

      const after = new Date('2026-06-29T07:00:00Z');
      expect((await svc.sweepDueReviews(after)).resurfaced).toBe(1);
      const row = await prisma.crossZoneEscalation.findUniqueOrThrow({ where: { escalationId } });
      expect(row.status).toBe('PENDING');
      // The date is consumed, not kept: a review date left behind resurfaces the same row every tick.
      expect(row.reviewDate).toBeNull();
      expect(row.decidedAt).toBeNull();

      expect(
        await prisma.notification.count({
          where: { recipientUserId: csmUserId, type: 'CROSS_ZONE_REVIEW_DUE', entityId: ticketId },
        }),
      ).toBe(1);
      // The home ZM was told it was parked; they are told it is back.
      expect(
        await prisma.notification.count({
          where: { recipientUserId: zmUserId, type: 'CROSS_ZONE_DECISION', entityId: ticketId },
        }),
      ).toBe(2);

      // Idempotent: the row is PENDING and back in the queue, not resurfaced again on the next tick.
      expect((await svc.sweepDueReviews(after)).resurfaced).toBe(0);
      expect(
        await prisma.notification.count({
          where: { recipientUserId: csmUserId, type: 'CROSS_ZONE_REVIEW_DUE', entityId: ticketId },
        }),
      ).toBe(1);
    });

    it('AC5 — history reads the decision chain: decider, acting role, reason and date', async () => {
      const t = await makeTicket({ tier: 'GOLD', bucket: 'CRITICAL', ageMin: 30 });
      const actingCsm: CrossZoneActor = {
        userId: csmUserId,
        role: 'CENTRAL_SERVICE_MANAGER',
        actedAsRole: 'ZONAL_MANAGER',
        actingZone: Number(homeZoneId),
        zoneId: null,
      };
      expect((await svc.flag(t, 'no local cover', ZM, NOW)).result).toBe('OK');
      const esc = await escFor(t);
      expect((await svc.deny(esc.escalationId, 'target zones also full', actingCsm, NOW)).result).toBe('OK');

      const rows = await svc.history({ role: 'CENTRAL_SERVICE_MANAGER', zoneId: null }, {});
      const mine = rows.filter((r) => r.escalationId === String(esc.escalationId));

      const raised = mine.find((r) => r.action === 'CROSS_ZONE_MANUAL_FLAG');
      expect(raised?.decidedByUserId).toBe(zmUserId);
      expect(raised?.reason).toBe('no local cover');
      expect(raised?.ticketId).toBe(t);

      const denied = mine.find((r) => r.action === 'CROSS_ZONE_DENIED');
      expect(denied?.decidedByRole).toBe('CENTRAL_SERVICE_MANAGER');
      // The point of the column: a CSM deciding under a ZM's backup authority is not a ZM's decision.
      expect(denied?.actedAsRole).toBe('ZONAL_MANAGER');
      expect(denied?.reason).toBe('target zones also full');
      expect(denied?.at).toBeTruthy();
      expect(denied?.homeZoneId).toBe(String(homeZoneId));
    });

    it('AC5 — history is zone-clamped: a ZM sees their own zone’s escalations and no other zone’s', async () => {
      const t = await makeTicket({ tier: 'GOLD', bucket: 'CRITICAL', ageMin: 30 });
      expect((await svc.flag(t, 'home zone only', ZM, NOW)).result).toBe('OK');
      const esc = await escFor(t);

      const homeRows = await svc.history({ role: 'ZONAL_MANAGER', zoneId: Number(homeZoneId) }, {});
      expect(homeRows.some((r) => r.escalationId === String(esc.escalationId))).toBe(true);
      expect(homeRows.every((r) => r.homeZoneId === String(homeZoneId) || r.targetZoneId === String(homeZoneId))).toBe(true);

      const otherRows = await svc.history({ role: 'ZONAL_MANAGER', zoneId: Number(targetZoneId) }, {});
      expect(otherRows.some((r) => r.escalationId === String(esc.escalationId))).toBe(false);
    });

    it('AC5 — an approved escalation’s history is visible to the zone that has to do the work', async () => {
      const { escalationId } = await escalate();
      expect((await svc.approve(escalationId, Number(targetZoneId), targetSe, CSM, NOW)).result).toBe('OK');

      const targetRows = await svc.history({ role: 'ZONAL_MANAGER', zoneId: Number(targetZoneId) }, {});
      const approved = targetRows.find(
        (r) => r.escalationId === String(escalationId) && r.action === 'CROSS_ZONE_APPROVE',
      );
      expect(approved).toBeDefined();
      expect(approved?.direction).toBe('incoming');
      expect(approved?.decidedByRole).toBe('CENTRAL_SERVICE_MANAGER');
    });
  });
});
