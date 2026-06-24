import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';
import { BatchAssignmentService } from '../src/scheduling/batch-assignment.service';
import { LoggingDayPlanNotifier } from '../src/scheduling/day-plan-notifier';
import { OverrideService } from '../src/scheduling/override.service';
import type { SoftStateConflictPort } from '../src/scheduling/soft-state-conflict';

/**
 * Issue 13a, slice 5 — ON_SITE override conflict (AC#5, LLD §12.4). An override that touches a ticket
 * the SE holds ON_SITE on returns a conflict (no mutation) unless confirm=true; a confirmed override
 * proceeds and writes an OVERRIDE_AFTER_ON_SITE audit row. The held ON_SITE is never silently cleared.
 * soft_states lands in Issue 15, so the conflict source is a seam — here a fake reports one ticket.
 */
const NS = Date.now();

describe('Issue 13a slice 5 — ON_SITE override conflict', () => {
  let prisma: PrismaService;
  let rec: RecommenderService;
  let dispatch: BatchAssignmentService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let se: string;
  let batchId: bigint;
  let onSiteTicket: string;
  const userIds: string[] = [];
  const deviceIds: bigint[] = [];
  const ticketIds: string[] = [];
  const ZM = { userId: '11111111-1111-1111-1111-111111111111', role: 'ZONAL_MANAGER', actedAsRole: null };
  const NOW = new Date('2026-06-21T06:00:00Z');
  let scope: { role: string; zoneId: number };

  // Fake conflict port: reports onSiteTicket as held ON_SITE (Issue 15 will wire the real soft_states).
  const conflictPort: SoftStateConflictPort = {
    activeOnSiteTicketIds: async (ids: string[]) => new Set(ids.filter((t) => t === onSiteTicket)),
  };

  const makeTicket = async (plant: bigint, gpsAgeMin: number): Promise<string> => {
    const deviceId = BigInt(10_500_000_000 + (NS % 100_000) * 10 + deviceIds.length);
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

    zoneId = (await prisma.zone.create({ data: { name: 'Z-os-' + NS } })).zoneId;
    scope = { role: 'ZONAL_MANAGER', zoneId: Number(zoneId) };
    companyId = (
      await prisma.company.create({ data: { name: 'Co-os-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-os-' + NS, zoneId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@os.test`, zoneId },
    });
    userIds.push(u.userId);
    se = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
    await prisma.seCoverage.create({ data: { seId: se, plantId, coverageType: 'DEDICATED' } });

    onSiteTicket = await makeTicket(plantId, 120);

    await rec.runForZone(zoneId, { now: NOW });
    await dispatch.dispatchForZone(zoneId, { dateFrom: NOW, dateTo: NOW, now: NOW });
    batchId = (await prisma.plantBatchAssignment.findFirstOrThrow({ where: { plantId } })).batchId;
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

  function svc(): OverrideService {
    return new OverrideService(prisma, new AuditService(prisma), new LoggingDayPlanNotifier(), conflictPort);
  }

  it('returns CONFLICT_ON_SITE without mutating when the SE holds ON_SITE and confirm is absent', async () => {
    const outcome = await svc().override(
      batchId,
      { action: 'REMOVE_TICKET', ticketId: onSiteTicket, reasonCode: 'X' },
      scope,
      ZM,
    );
    expect(outcome.result).toBe('CONFLICT_ON_SITE');
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: onSiteTicket } });
    expect(ticket.assignmentState).toBe('FORMALLY_ASSIGNED'); // untouched
    const batch = await prisma.plantBatchAssignment.findUniqueOrThrow({ where: { batchId } });
    expect(batch.status).toBe('AUTO_ASSIGNED'); // untouched
  });

  it('proceeds with confirm=true and records an OVERRIDE_AFTER_ON_SITE audit row', async () => {
    const outcome = await svc().override(
      batchId,
      { action: 'REMOVE_TICKET', ticketId: onSiteTicket, reasonCode: 'URGENT', confirm: true },
      scope,
      ZM,
    );
    expect(outcome.result).toBe('OK');
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId: onSiteTicket } });
    expect(ticket.assignmentState).toBe('UNASSIGNED');
    const audits = await prisma.auditLog.findMany({
      where: { entityType: 'plant_batch_assignment', entityId: String(batchId), action: 'OVERRIDE_AFTER_ON_SITE' },
    });
    expect(audits.length).toBe(1);
  });
});
