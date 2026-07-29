import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import { NotificationService } from '../src/notifications/notification.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { BulkUnassignService } from '../src/scheduling/bulk-unassign.service';
import { PrismaSoftStateConflictPort } from '../src/soft-state/soft-state-conflict.adapter';

/**
 * #179 Slice 1 — OH bulk unassign (zone / Pan-India), mid-day rebalance. Design settled and proven
 * in the filed issue (`.scratch/fsm-platform-v1/issues/179-oh-bulk-unassign-rebalance.md`) — do not
 * re-derive the scope predicate or the decisions here.
 */
const NS = Date.now();
const OH_ACTOR = { userId: '33333333-3333-3333-3333-333333333333', role: 'OPERATIONS_HEAD' };

describe('BulkUnassignService (#179 slice 1)', () => {
  let prisma: PrismaService;
  let svc: BulkUnassignService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let seId: string;
  let zoneId2: bigint;
  let companyId2: bigint;
  let plantId2: bigint;
  let seId2: string;
  let zoneId3: bigint;
  let companyId3: bigint;
  let plantId3: bigint;
  let seId3: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  const cycleIds: string[] = [];

  const NOW = new Date('2026-07-29T09:30:00Z');
  const DAY = new Date(Date.UTC(2026, 6, 29));

  const makeTicket = async (opts: {
    workType?: 'TROUBLESHOOT' | 'INSTALL' | 'RECOVERY';
    status?: string;
    assignmentState?: 'FORMALLY_ASSIGNED' | 'UNASSIGNED';
    cycleState?: 'OPEN' | 'WAITING_COMPONENT';
    deferredUntil?: Date;
    plantId?: bigint;
    companyId?: bigint;
  }): Promise<string> => {
    const deviceId = String(9_779_000_000 + (NS % 100_000) * 100 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    let failureCycleId: string | undefined;
    const workType = opts.workType ?? 'TROUBLESHOOT';
    if (workType === 'TROUBLESHOOT') {
      const cycle = await prisma.failureCycle.create({
        data: { deviceId, state: opts.cycleState ?? 'OPEN', openedAt: NOW },
      });
      cycleIds.push(cycle.cycleId);
      failureCycleId = cycle.cycleId;
    }
    const ticket = await prisma.ticket.create({
      data: {
        workType,
        status: opts.status ?? 'OPEN',
        failureCycleId,
        deviceId,
        plantId: opts.plantId ?? plantId,
        companyId: opts.companyId ?? companyId,
        companyTier: 'GOLD',
        assignmentState: opts.assignmentState ?? 'FORMALLY_ASSIGNED',
        deferredUntil: opts.deferredUntil ?? null,
        lastStateChangedAt: NOW,
      },
    });
    ticketIds.push(ticket.ticketId);
    return ticket.ticketId;
  };

  /** Places a ticket on a live (ACTIVE) schedule/batch for the zone/day, as dispatch would. */
  const placeOnLiveBatch = async (
    ticketId: string,
    opts: { forSeId?: string; forZoneId?: bigint; forPlantId?: bigint } = {},
  ): Promise<{ scheduleId: bigint; batchId: bigint }> => {
    const forSeId = opts.forSeId ?? seId;
    const forZoneId = opts.forZoneId ?? zoneId;
    const forPlantId = opts.forPlantId ?? plantId;
    let schedule = await prisma.workSchedule.findFirst({ where: { zoneId: forZoneId, seId: forSeId, dateFrom: DAY, status: 'ACTIVE' } });
    if (!schedule) {
      schedule = await prisma.workSchedule.create({
        data: { seId: forSeId, zoneId: forZoneId, dateFrom: DAY, dateTo: DAY, status: 'ACTIVE', source: 'SYSTEM_GENERATED', dispatchedAt: NOW },
      });
    }
    const batch = await prisma.plantBatchAssignment.create({
      data: { scheduleId: schedule.scheduleId, plantId: forPlantId, seId: forSeId, status: 'AUTO_ASSIGNED', stopSequence: 1 },
    });
    await prisma.batchAssignmentTicket.create({ data: { batchId: batch.batchId, ticketId, sortOrder: 1 } });
    return { scheduleId: schedule.scheduleId, batchId: batch.batchId };
  };

  const makeZoneFixture = async (label: string) => {
    const z = (await prisma.zone.create({ data: { name: `Z-bulk-${label}-` + NS } })).zoneId;
    const co = (await prisma.company.create({ data: { name: `Co-bulk-${label}-` + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    const pl = (await prisma.plant.create({ data: { name: `P-bulk-${label}-` + NS, zoneId: z } })).plantId;
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({ data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@bulk.test`, zoneId: z } });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({ data: { engineerId: u.userId, coverageType: 'DEDICATED', zoneId: z, dailyCapacity: 10 } });
    await prisma.seCoverage.create({ data: { seId: u.userId, plantId: pl, coverageType: 'DEDICATED' } });
    return { zoneId: z, companyId: co, plantId: pl, seId: u.userId };
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new BulkUnassignService(
      prisma,
      new AuditService(prisma),
      new NotificationService(prisma),
      new PrismaSoftStateConflictPort(prisma),
    );

    const f1 = await makeZoneFixture('a');
    zoneId = f1.zoneId;
    companyId = f1.companyId;
    plantId = f1.plantId;
    seId = f1.seId;

    const f2 = await makeZoneFixture('b');
    zoneId2 = f2.zoneId;
    companyId2 = f2.companyId;
    plantId2 = f2.plantId;
    seId2 = f2.seId;

    const f3 = await makeZoneFixture('c');
    zoneId3 = f3.zoneId;
    companyId3 = f3.companyId;
    plantId3 = f3.plantId;
    seId3 = f3.seId;
  });

  afterAll(async () => {
    const allZoneIds = [zoneId, zoneId2, zoneId3];
    const allPlantIds = [plantId, plantId2, plantId3];
    const allCompanyIds = [companyId, companyId2, companyId3];
    await prisma.notificationDelivery.deleteMany({ where: { notification: { entityId: { in: ticketIds } } } });
    await prisma.notification.deleteMany({ where: { entityId: { in: ticketIds } } });
    await prisma.auditLog.deleteMany({ where: { actingZone: { in: allZoneIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.softState.deleteMany({ where: { ticketId: { in: ticketIds } } });
    const schedules = await prisma.workSchedule.findMany({ where: { zoneId: { in: allZoneIds } }, select: { scheduleId: true } });
    const batches = await prisma.plantBatchAssignment.findMany({ where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } }, select: { batchId: true } });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.workSchedule.deleteMany({ where: { zoneId: { in: allZoneIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { cycleId: { in: cycleIds } } });
    await prisma.seCoverage.deleteMany({ where: { plantId: { in: allPlantIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: allPlantIds } } });
    await prisma.company.deleteMany({ where: { companyId: { in: allCompanyIds } } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: allZoneIds } } });
    await prisma.onModuleDestroy();
  });

  it('preview classifies every settled class correctly for one zone and mints a token', async () => {
    // eligible — plain OPEN, no soft state, no component block
    const eligible = await makeTicket({});
    await placeOnLiveBatch(eligible);

    // component-blocked — cycle WAITING_COMPONENT, ticket stays OPEN (ADR-0008)
    const blocked = await makeTicket({ cycleState: 'WAITING_COMPONENT' });
    await placeOnLiveBatch(blocked);

    // closed-excluded — the #178 standing defect shape: CLOSED but still FORMALLY_ASSIGNED with a live batch row
    const closed = await makeTicket({ status: 'CLOSED' });
    await placeOnLiveBatch(closed);

    // install/recovery-excluded — dispatched INSTALL ticket
    const install = await makeTicket({ workType: 'INSTALL', status: 'REQUESTED' });
    await placeOnLiveBatch(install);

    // deferred-excluded — already UNASSIGNED with a future deferral; not reachable via any live batch row
    await makeTicket({ assignmentState: 'UNASSIGNED', deferredUntil: new Date(Date.UTC(2026, 6, 30)) });

    const preview = await svc.preview({ scope: 'ZONE', zoneId, reasonCode: 'ROUTINE_REBALANCE' }, NOW);

    expect(preview.zones).toHaveLength(1);
    const zone = preview.zones[0];
    expect(zone.zoneId).toBe(zoneId.toString());
    expect(zone.counts).toEqual({
      eligible: 1,
      onSite: 0,
      componentBlocked: 1,
      closedExcluded: 1,
      installRecoveryExcluded: 1,
      deferredExcluded: 1,
    });
    expect(preview.previewToken).toEqual(expect.any(String));
    expect(preview.operationId).toEqual(expect.any(String));
  });

  it('PAN_INDIA preview aggregates every active zone, each with its own correct counts', async () => {
    // Uses zone2/zone3 — deliberately NOT zone1, which the previous test already populated. Every
    // other e2e spec's fixture zones are also live in this shared test DB, so this asserts on OUR
    // zones by id rather than on the returned list's length.
    const eligibleZone2 = await makeTicket({ plantId: plantId2, companyId: companyId2 });
    await placeOnLiveBatch(eligibleZone2, { forSeId: seId2, forZoneId: zoneId2, forPlantId: plantId2 });

    const eligibleZone3 = await makeTicket({ plantId: plantId3, companyId: companyId3 });
    await placeOnLiveBatch(eligibleZone3, { forSeId: seId3, forZoneId: zoneId3, forPlantId: plantId3 });
    const onSiteZone3 = await makeTicket({ plantId: plantId3, companyId: companyId3 });
    await placeOnLiveBatch(onSiteZone3, { forSeId: seId3, forZoneId: zoneId3, forPlantId: plantId3 });
    await prisma.softState.create({ data: { ticketId: onSiteZone3, seId: seId3, type: 'ON_SITE' } });

    const preview = await svc.preview({ scope: 'PAN_INDIA', reasonCode: 'ROUTINE_REBALANCE' }, NOW);

    const zone2 = preview.zones.find((z) => z.zoneId === zoneId2.toString());
    const zone3 = preview.zones.find((z) => z.zoneId === zoneId3.toString());
    expect(zone2?.counts).toEqual({ ...ZERO, eligible: 1 });
    expect(zone3?.counts).toEqual({ ...ZERO, eligible: 1, onSite: 1 });
  });
});

const ZERO = { eligible: 0, onSite: 0, componentBlocked: 0, closedExcluded: 0, installRecoveryExcluded: 0, deferredExcluded: 0 };
