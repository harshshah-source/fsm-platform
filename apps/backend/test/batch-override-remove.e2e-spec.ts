import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { OverrideService } from '../src/scheduling/override.service';
import type { DayPlanNotifier } from '../src/scheduling/day-plan-notifier';

/**
 * Issue 13a, slice 2 — override engine + REMOVE_TICKET (AC#3/#4). Removing a ticket from a batch:
 * marks it removed (audit-preserving), returns the ticket to UNASSIGNED (back to the Shared Pool),
 * flips the batch + schedule to OVERRIDDEN with the mandatory reason and overrider, audits, and fires
 * a push to the SE.
 */
const NS = Date.now();

class RecordingNotifier implements DayPlanNotifier {
  readonly dispatched: unknown[] = [];
  readonly overridden: { seId: string; batchId: bigint; action: string }[] = [];
  dayPlanDispatched(event: unknown): void {
    this.dispatched.push(event);
  }
  dayPlanOverridden(event: { seId: string; batchId: bigint; action: string }): void {
    this.overridden.push(event);
  }
}

describe('Issue 13a slice 2 — OverrideService REMOVE_TICKET', () => {
  let prisma: PrismaService;
  let rec: RecommenderService;
  let dispatch: BatchAssignmentService;
  let override: OverrideService;
  const notifier = new RecordingNotifier();

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let se: string;
  let batchId: bigint;
  const userIds: string[] = [];
  const deviceIds: bigint[] = [];
  const ticketIds: string[] = [];
  let removedTicket: string;
  let keptTicket: string;
  const ZM = { userId: '11111111-1111-1111-1111-111111111111', role: 'ZONAL_MANAGER', actedAsRole: null };
  const NOW = new Date('2026-06-21T06:00:00Z');

  const makeTicket = async (plant: bigint, gpsAgeMin: number): Promise<string> => {
    const deviceId = BigInt(10_200_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId,
        isInactive: true,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        hasOpenFailureCycle: true,
        latestGpsDatetime: new Date(NOW.getTime() - gpsAgeMin * 60_000),
        plantId: plant,
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
        plantId: plant,
        companyId,
        companyTier: 'GOLD',
        lastStateChangedAt: NOW,
      },
    });
    ticketIds.push(ticket.ticketId);
    return ticket.ticketId;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    rec = new RecommenderService(prisma, new CandidateSelectionService(prisma));
    dispatch = new BatchAssignmentService(prisma);
    override = new OverrideService(prisma, new AuditService(prisma), notifier);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-ovr-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-ovr-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-ovr-' + NS, zoneId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@ovr.test`, zoneId },
    });
    userIds.push(u.userId);
    se = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
    await prisma.seCoverage.create({ data: { seId: se, plantId, coverageType: 'DEDICATED' } });

    removedTicket = await makeTicket(plantId, 180);
    keptTicket = await makeTicket(plantId, 60);

    await rec.runForZone(zoneId, { now: NOW });
    await dispatch.dispatchForZone(zoneId, { dateFrom: NOW, dateTo: NOW, now: NOW });

    batchId = (await prisma.plantBatchAssignment.findFirstOrThrow({ where: { plantId } })).batchId;
    await override.override(
      batchId,
      { action: 'REMOVE_TICKET', ticketId: removedTicket, reasonCode: 'WRONG_PLANT' },
      { role: 'ZONAL_MANAGER', zoneId: Number(zoneId) },
      ZM,
    );
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
    await prisma.auditLog.deleteMany({ where: { entityType: 'plant_batch_assignment', entityId: String(batchId) } });
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seCoverage.deleteMany({ where: { plantId } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('marks the removed ticket removed and returns it to UNASSIGNED (Shared Pool)', async () => {
    const bat = await prisma.batchAssignmentTicket.findFirstOrThrow({ where: { batchId, ticketId: removedTicket } });
    expect(bat.removedAt).not.toBeNull();
    expect(bat.removedBy).toBe(ZM.userId);
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: removedTicket } });
    expect(ticket.assignmentState).toBe('UNASSIGNED');
  });

  it('keeps the other ticket assigned in the batch', async () => {
    const kept = await prisma.batchAssignmentTicket.findFirstOrThrow({ where: { batchId, ticketId: keptTicket } });
    expect(kept.removedAt).toBeNull();
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: keptTicket } });
    expect(ticket.assignmentState).toBe('FORMALLY_ASSIGNED');
  });

  it('flips batch + schedule to OVERRIDDEN with the reason and overrider', async () => {
    const batch = await prisma.plantBatchAssignment.findUniqueOrThrow({ where: { batchId } });
    expect(batch.status).toBe('OVERRIDDEN');
    expect(batch.overrideReason).toBe('WRONG_PLANT');
    const schedule = await prisma.workSchedule.findUniqueOrThrow({ where: { scheduleId: batch.scheduleId } });
    expect(schedule.status).toBe('OVERRIDDEN');
    expect(schedule.lastOverriddenBy).toBe(ZM.userId);
    expect(schedule.lastOverriddenAt).not.toBeNull();
  });

  it('audits the override and fires a push to the SE', async () => {
    const audits = await prisma.auditLog.findMany({
      where: { entityType: 'plant_batch_assignment', entityId: String(batchId) },
    });
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits[0].action).toContain('OVERRIDE');
    expect(notifier.overridden.some((e) => e.seId === se && e.action === 'REMOVE_TICKET')).toBe(true);
  });
});
