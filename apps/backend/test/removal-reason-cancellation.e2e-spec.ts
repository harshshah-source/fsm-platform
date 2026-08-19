import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import { ComponentRequestService } from '../src/component-request/component-request.service';
import { DeviceDepartureService } from '../src/device-departure/device-departure.service';
import { PlantDeactivationService } from '../src/plant-deactivation/plant-deactivation.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ALL_REMOVAL_REASONS, REMOVAL_REASONS } from '../src/scheduling/removal-reason';

/**
 * #241 — the two paths that ended an assignment **without ever touching the assignment row**, and the
 * structural guarantees the reason column exists to support.
 *
 * The leak both paths shared: every day-plan read filters on `removed_at IS NULL` and *not* on ticket
 * status (`me-tickets-query.service.ts:50`, `day-plan-query.service.ts:48`, the ZM schedule view, the
 * transparency reads). So a path that closed or unassigned a ticket while leaving its batch row live
 * left the ticket rendering on the SE's day plan as work to do — 3,310 such rows in the dev mirror, 20
 * on ACTIVE schedules. Neither path had a test that looked at the assignment row at all, which is why
 * both survived: they each asserted the thing they *did* change.
 *
 * The other two cases here are structural rather than behavioural — an invariant (every removed row
 * carries a cause) and the indexes #244's per-ticket history read needs — and are asserted against the
 * database itself, since that is the only place they are true or false.
 */
const NS = Date.now();
const NOW = new Date('2026-06-24T09:00:00Z');

describe('#241 — cancellation stamps, the removed-row invariant, and the history indexes', () => {
  let prisma: PrismaService;
  let deactivation: PlantDeactivationService;
  let components: ComponentRequestService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let componentId: bigint;
  let se: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];
  const OH = { userId: '22222222-2222-2222-2222-222222222222', role: 'OPERATIONS_HEAD', actedAsRole: null };

  /** A ticket that is live on an SE's day plan: schedule → batch → live `batch_assignment_tickets` row. */
  const makeAssignedTicket = async (): Promise<{ ticketId: string; cycleId: string }> => {
    const deviceId = String(12_100_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        hasOpenFailureCycle: true,
        latestGpsDatetime: new Date(NOW.getTime() - 120 * 60_000),
        plantId,
        companyId,
        computedAt: NOW,
      },
    });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        failureCycleId: cycle.cycleId,
        deviceId,
        plantId,
        companyId,
        companyTier: 'GOLD',
        assignmentState: 'FORMALLY_ASSIGNED',
        lastStateChangedAt: NOW,
      },
    });
    ticketIds.push(ticket.ticketId);

    // Find-or-create: `work_schedules_one_active_per_se_zone_day` allows the SE exactly one live
    // schedule per zone per day, so successive fixtures share the plan rather than minting a second.
    const schedule =
      (await prisma.workSchedule.findFirst({ where: { seId: se, zoneId, status: 'ACTIVE' } })) ??
      (await prisma.workSchedule.create({
        data: { seId: se, zoneId, dateFrom: NOW, dateTo: NOW, status: 'ACTIVE', dispatchedAt: NOW },
      }));
    const batch =
      (await prisma.plantBatchAssignment.findFirst({ where: { scheduleId: schedule.scheduleId, plantId, seId: se } })) ??
      (await prisma.plantBatchAssignment.create({
        data: { scheduleId: schedule.scheduleId, plantId, seId: se, status: 'AUTO_ASSIGNED', stopSequence: 1 },
      }));
    await prisma.batchAssignmentTicket.create({
      data: { batchId: batch.batchId, ticketId: ticket.ticketId, sortOrder: 1 },
    });
    return { ticketId: ticket.ticketId, cycleId: cycle.cycleId };
  };

  const liveRowsFor = (ticketId: string) =>
    prisma.batchAssignmentTicket.findMany({ where: { ticketId, removedAt: null } });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    deactivation = new PlantDeactivationService(prisma, new AuditService(prisma));
    components = new ComponentRequestService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-rr-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-rr-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-rr-' + NS, zoneId } })).plantId;
    componentId = (await prisma.componentMaster.create({ data: { name: 'cable-rr-' + NS } })).componentId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@rr.test`, zoneId },
    });
    userIds.push(u.userId);
    se = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
    await prisma.seCoverage.create({ data: { seId: se, plantId, coverageType: 'DEDICATED' } });
  });

  afterAll(async () => {
    const schedules = await prisma.workSchedule.findMany({ where: { zoneId }, select: { scheduleId: true } });
    const batches = await prisma.plantBatchAssignment.findMany({
      where: { scheduleId: { in: schedules.map((s) => s.scheduleId) } },
      select: { batchId: true },
    });
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { batchId: { in: batches.map((b) => b.batchId) } } });
    await prisma.workSchedule.deleteMany({ where: { zoneId } });
    await prisma.componentRequest.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.troubleshootingSubmission.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [...ticketIds, String(plantId)] } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seCoverage.deleteMany({ where: { plantId } });
    await prisma.deviceDeparture.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.plantDeactivation.deleteMany({ where: { plantId } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.componentMaster.deleteMany({ where: { componentId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  /**
   * AC-3 — plant deactivation cancels the plant's open tickets. Before #241 it closed the ticket and
   * terminated the cycle but never touched the batch row, so the cancelled ticket stayed on the SE's
   * day plan: a truck roll to a plant the business had just switched off.
   */
  it('AC-3: plant deactivation stamps TICKET_CANCELLED and clears the ticket off the day plan', async () => {
    const { ticketId } = await makeAssignedTicket();
    expect(await liveRowsFor(ticketId)).toHaveLength(1); // live on the plan before deactivation

    const outcome = await deactivation.deactivate(plantId, 'site closed for the season', OH);
    expect(outcome.result).toBe('OK');

    const row = await prisma.batchAssignmentTicket.findFirstOrThrow({ where: { ticketId } });
    expect(row.removedAt).not.toBeNull();
    expect(row.removalReason).toBe(REMOVAL_REASONS.TICKET_CANCELLED);
    // NULL actor: the OH deactivated the *plant*; nobody withdrew this ticket by hand.
    expect(row.removedBy).toBeNull();
    // The day-plan predicate itself — every SE-facing read spreads `removedAt: null`.
    expect(await liveRowsFor(ticketId)).toHaveLength(0);
  });

  /**
   * AC-4 — a component arriving at the plant warehouse returns a Floating SE's ticket to the open
   * pool. `assignment_state` flipped to UNASSIGNED while the batch row stayed live, which is the same
   * invariant broken from the other side: the ticket was simultaneously unassigned and on a day plan.
   */
  it('AC-4: returning a ticket to the pool on component arrival stamps COMPONENT_WAIT', async () => {
    const { ticketId, cycleId } = await makeAssignedTicket();
    // RETURN_TO_POOL is the FLOATING + PLANT_WAREHOUSE combination (ADR-0008 resubmit ownership).
    const floatingTag = randomUUID().slice(0, 8);
    const floatingUser = await prisma.user.create({
      data: {
        name: 'SE ' + floatingTag,
        role: 'SERVICE_ENGINEER',
        phone: 'ph-' + floatingTag,
        email: `${floatingTag}@rr.test`,
        zoneId,
      },
    });
    userIds.push(floatingUser.userId);
    await prisma.engineerMaster.create({
      data: { engineerId: floatingUser.userId, coverageType: 'FLOATING', zoneId, dailyCapacity: 10 },
    });
    const submission = await prisma.troubleshootingSubmission.create({
      data: {
        ticketId,
        failureCycleId: cycleId,
        submissionType: 'TROUBLESHOOTING_FORM',
        clientSubmissionId: randomUUID(),
        seId: floatingUser.userId,
        presenceSource: 'NONE',
        componentUnavailable: true,
        // `ts_submissions_component_unavailable_item` — the flag and the named item travel together.
        componentUnavailableItem: componentId,
        rootCauseCategory: 'GPS_ANTENNA_ISSUE',
        submittedAt: NOW,
      },
    });
    const request = await prisma.componentRequest.create({
      data: {
        ticketId,
        seId: floatingUser.userId,
        failureCycleId: cycleId,
        submissionId: submission.submissionId,
        status: 'RECEIVED',
        deliveryDestination: 'PLANT_WAREHOUSE',
        receivedAt: NOW,
      },
    });

    const outcome = await components.confirmResubmit(request.requestId, { userId: se, role: 'ZONAL_MANAGER' }, NOW);
    expect(outcome.result).toBe('OK');
    expect(outcome.result === 'OK' && outcome.ownership.mode).toBe('RETURN_TO_POOL');

    const row = await prisma.batchAssignmentTicket.findFirstOrThrow({ where: { ticketId } });
    expect(row.removalReason).toBe(REMOVAL_REASONS.COMPONENT_WAIT);
    expect(await liveRowsFor(ticketId)).toHaveLength(0);
  });

  /**
   * AC-3 (the other half) — device departure is the same leak at device grain, and the more costly
   * one: 3,310 live rows on cancelled tickets in the dev mirror came from this path, 20 of them on
   * ACTIVE schedules. Driven through `reconcile` with a single observed non-operational status, which
   * is the `SOURCE_STATUS` path — the trusted one, applied unconditionally.
   */
  it('AC-3: device departure stamps TICKET_CANCELLED on the departed device’s live rows', async () => {
    const { ticketId } = await makeAssignedTicket();
    const device = await prisma.ticket.findUniqueOrThrow({ where: { ticketId }, select: { deviceId: true } });
    expect(await liveRowsFor(ticketId)).toHaveLength(1);

    // `syncedPlantIds: []` keeps the absence path inert — only the explicitly observed device departs,
    // so this cannot disturb any other fixture's devices sharing the test database.
    const result = await new DeviceDepartureService(prisma).reconcile({
      observed: new Map([[device.deviceId!, 'UNDEPLOYED']]),
      syncedPlantIds: [],
      now: NOW,
    });
    expect(result.departed).toBe(1);

    const row = await prisma.batchAssignmentTicket.findFirstOrThrow({ where: { ticketId } });
    expect(row.removalReason).toBe(REMOVAL_REASONS.TICKET_CANCELLED);
    expect(await liveRowsFor(ticketId)).toHaveLength(0);
  });

  /**
   * AC-2 — the invariant the migration's backfill establishes and every writer must preserve: a
   * removed row always says why. Asserted over the whole table rather than the fixture, so any writer
   * anywhere — including one added later that forgets to stamp — fails here.
   */
  it('AC-2: no removed row anywhere is missing its reason, and every reason is in the vocabulary', async () => {
    const orphans = await prisma.batchAssignmentTicket.count({
      where: { removedAt: { not: null }, removalReason: null },
    });
    expect(orphans).toBe(0);

    // The mirror of the same invariant: a live row has no reason, because it has not ended.
    const premature = await prisma.batchAssignmentTicket.count({
      where: { removedAt: null, removalReason: { not: null } },
    });
    expect(premature).toBe(0);

    // Free text would defeat the point — #244 reads the reason as a predicate, so a typo would
    // silently reclassify an attempt rather than showing up as a visible mistake.
    const distinct = await prisma.batchAssignmentTicket.findMany({
      where: { removalReason: { not: null } },
      distinct: ['removalReason'],
      select: { removalReason: true },
    });
    for (const { removalReason } of distinct) {
      expect(ALL_REMOVAL_REASONS).toContain(removalReason);
    }
  });

  /**
   * AC-5 — #244 walks a ticket's assignment windows and joins the soft states inside each. Neither
   * read had a usable index: `batch_assignment_tickets` carried only `(batch_id)` and the live-row
   * partial unique (which a history read, removed rows included, cannot use), and `soft_states` only
   * `(se_id, resolved_at)`, which serves the SE's live view rather than a per-ticket time join.
   */
  it('AC-5: the per-ticket history indexes exist', async () => {
    const indexes = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
       WHERE (tablename = 'batch_assignment_tickets' AND indexdef LIKE '%(ticket_id)%')
          OR (tablename = 'soft_states' AND indexdef LIKE '%(ticket_id, set_at)%')`;
    const names = indexes.map((i) => i.indexname);
    expect(names).toContain('batch_assignment_tickets_ticket_id_idx');
    expect(names).toContain('soft_states_ticket_id_set_at_idx');
  });
});
