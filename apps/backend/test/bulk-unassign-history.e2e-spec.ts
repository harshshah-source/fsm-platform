import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import { NotificationService } from '../src/notifications/notification.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { BulkUnassignService } from '../src/scheduling/bulk-unassign.service';
import { PrismaSoftStateConflictPort } from '../src/soft-state/soft-state-conflict.adapter';

/**
 * #179 Slice 4 — `BulkUnassignService.history()`, the read behind the admin page's history list
 * (`audit_logs` where `action = 'BULK_UNASSIGN_ZONE'`). Design settled in
 * `.scratch/fsm-platform-v1/issues/179-oh-bulk-unassign-rebalance.md`.
 */
const NS = Date.now();
const OH_ACTOR = { userId: '33333333-3333-3333-3333-333333333333', role: 'OPERATIONS_HEAD' };
const NOW = new Date('2026-07-29T09:30:00Z');
const DAY = new Date(Date.UTC(2026, 6, 29));

describe('BulkUnassignService.history (#179 slice 4)', () => {
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

  it('lists a completed unassign with zone name, counts and ticketsUnassigned, and a lock-skipped run with skipReason', async () => {
    const zoneId = (await prisma.zone.create({ data: { name: 'Z-history-' + NS } })).zoneId;
    const companyId = (await prisma.company.create({ data: { name: 'Co-history-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    const plantId = (await prisma.plant.create({ data: { name: 'P-history-' + NS, zoneId } })).plantId;
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({ data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@history.test`, zoneId } });
    await prisma.engineerMaster.create({ data: { engineerId: u.userId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
    await prisma.seCoverage.create({ data: { seId: u.userId, plantId, coverageType: 'DEDICATED' } });

    const deviceId = String(9_822_000_000 + (NS % 100_000));
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
    const ticket = await prisma.ticket.create({
      data: { workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: cycle.cycleId, deviceId, plantId, companyId, companyTier: 'GOLD', assignmentState: 'FORMALLY_ASSIGNED', lastStateChangedAt: NOW },
    });
    const schedule = await prisma.workSchedule.create({
      data: { seId: u.userId, zoneId, dateFrom: DAY, dateTo: DAY, status: 'ACTIVE', source: 'SYSTEM_GENERATED', dispatchedAt: NOW },
    });
    const batch = await prisma.plantBatchAssignment.create({
      data: { scheduleId: schedule.scheduleId, plantId, seId: u.userId, status: 'AUTO_ASSIGNED', stopSequence: 1 },
    });
    await prisma.batchAssignmentTicket.create({ data: { batchId: batch.batchId, ticketId: ticket.ticketId, sortOrder: 1 } });

    try {
      const outcome = await svc.execute({ scope: 'ZONE', zoneId, reasonCode: 'ROUTINE_REBALANCE' }, OH_ACTOR, NOW);
      if (outcome.result !== 'OK') throw new Error(`expected OK, got ${outcome.result}`);

      const rows = await svc.history(50);
      const mine = rows.find((r) => r.zoneId === zoneId.toString());
      expect(mine).toBeDefined();
      expect(mine!.zoneName).toBe('Z-history-' + NS);
      expect(mine!.scope).toBe('ZONE');
      expect(mine!.reasonCode).toBe('ROUTINE_REBALANCE');
      expect(mine!.skipped).toBe(false);
      expect(mine!.skipReason).toBeNull();
      expect(mine!.ticketsUnassigned).toBe(1);
      expect(mine!.counts).toEqual({ eligible: 1, onSite: 0, componentBlocked: 0, closedExcluded: 0, installRecoveryExcluded: 0, deferredExcluded: 0 });
      expect(mine!.actorId).toBe(OH_ACTOR.userId);
      expect(mine!.operationId).toBe(outcome.operationId);
      expect(mine!.createdAt).toEqual(expect.any(String));

      // #340 AC3 — the target zone is `entity_id`, and `acting_zone` is left alone.
      //
      // A rebalance is not an acting session. Writing its target zone into `acting_zone` overloaded a
      // column whose one reader — the CSM-backup-share report — takes any non-null value there as "a
      // manager was standing in for this zone's ZM", so every pan-India run quietly inflated the
      // denominator of a number Operations Head uses to decide whether a zone's ZM needs help.
      //
      // The zone did not need a new home: `entity_type = 'zones'` / `entity_id` already said which
      // zone this row is about, for this row and for every row written before the fix — which is why
      // `history()` above still finds and names the zone, on old and new rows alike, with nothing
      // backfilled.
      const written = await prisma.auditLog.findMany({
        where: { action: 'BULK_UNASSIGN_ZONE', entityId: zoneId.toString() },
      });
      expect(written.length).toBeGreaterThan(0);
      for (const row of written) {
        expect(row.actingZone).toBeNull();
        expect(row.entityType).toBe('zones');
      }

      // A second, lock-contended run for the same zone — the skip must appear in history too.
      const holder = new PrismaService();
      await holder.onModuleInit();
      try {
        await holder.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtext(${'dispatch_zone_' + zoneId.toString()}))`;
          const skipOutcome = await svc.execute({ scope: 'ZONE', zoneId, reasonCode: 'SECOND_PASS' }, OH_ACTOR, NOW);
          if (skipOutcome.result !== 'OK') throw new Error(`expected OK, got ${skipOutcome.result}`);
          const rows2 = await svc.history(50);
          const mineRows = rows2.filter((r) => r.zoneId === zoneId.toString());
          const skipRow = mineRows.find((r) => r.skipped);
          expect(skipRow).toBeDefined();
          expect(skipRow!.skipReason).toBe('LOCK_CONTENDED');
          expect(skipRow!.ticketsUnassigned).toBe(0);
        });
      } finally {
        await holder.onModuleDestroy();
      }
    } finally {
      await prisma.notificationDelivery.deleteMany({ where: { notification: { entityId: zoneId.toString() } } });
      await prisma.notification.deleteMany({ where: { entityId: zoneId.toString() } });
      await prisma.auditLog.deleteMany({ where: { action: 'BULK_UNASSIGN_ZONE', entityId: zoneId.toString() } });
      await prisma.ticketEvent.deleteMany({ where: { ticketId: ticket.ticketId } });
      await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: batch.batchId } });
      await prisma.plantBatchAssignment.deleteMany({ where: { batchId: batch.batchId } });
      await prisma.workSchedule.deleteMany({ where: { scheduleId: schedule.scheduleId } });
      await prisma.ticket.deleteMany({ where: { ticketId: ticket.ticketId } });
      await prisma.failureCycle.deleteMany({ where: { deviceId } });
      await prisma.seCoverage.deleteMany({ where: { plantId } });
      await prisma.device.deleteMany({ where: { deviceId } });
      await prisma.engineerMaster.deleteMany({ where: { engineerId: u.userId } });
      await prisma.user.deleteMany({ where: { userId: u.userId } });
      await prisma.plant.deleteMany({ where: { plantId } });
      await prisma.company.deleteMany({ where: { companyId } });
      await prisma.zone.deleteMany({ where: { zoneId } });
    }
  });
});
