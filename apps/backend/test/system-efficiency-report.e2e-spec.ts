import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { ReportsService } from '../src/reports/reports.service';
import { SystemEfficiencyAggregationService } from '../src/reports/system-efficiency-aggregation.service';

/**
 * Issue 42 — the System Efficiency Report aggregation + read. Seeds one UTC day across the metric
 * families (detection, tickets, auto/manual/override assignment, resolution + downtime, verification +
 * auto-recovery, stage times, recovery closure, auto-escalations), recomputes the daily cube, and
 * asserts the fleet rollup + per-zone breakdown + filters.
 */
const NS = Date.now();
const DAY = '2026-06-20';
const at = (h: number, m = 0) => new Date(Date.UTC(2026, 5, 20, h, m, 0));

describe('Issue 42 — System Efficiency Report', () => {
  let prisma: PrismaService;
  let agg: SystemEfficiencyAggregationService;
  let reports: ReportsService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let deviceId: bigint;
  let se: string;
  let tsTicketId: string;
  let recoveryTicketId: string;
  let cycleId: string;
  let batchId: bigint;
  const userIds: string[] = [];
  const ticketIds: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    agg = new SystemEfficiencyAggregationService(prisma);
    reports = new ReportsService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-eff-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-eff-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-eff-' + NS, zoneId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({ data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@eff.test`, zoneId } });
    se = u.userId;
    userIds.push(se);
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });

    deviceId = BigInt(13_900_000_000 + (NS % 100_000));
    await prisma.device.create({ data: { deviceId, deviceType: 'GPS-EFF' } });
    await prisma.deviceState.create({ data: { deviceId, plantId, companyId, computedAt: at(0) } });

    // Failure cycle opened 02:00, resolved VERIFIED 06:00 → downtime 4h, first-time-fix, SLA-compliant.
    cycleId = (await prisma.failureCycle.create({ data: { deviceId, state: 'VERIFIED', openedAt: at(2), closedAt: at(6), repeatFailure: false } })).cycleId;

    // Troubleshoot ticket created 02:30 (detection→ticket = 30 min).
    tsTicketId = (await prisma.ticket.create({
      data: { workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: cycleId, deviceId, plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: at(2, 30), createdAt: at(2, 30) },
    })).ticketId;
    ticketIds.push(tsTicketId);

    // Recovery ticket created 01:00, closed (warehouse receipt) 05:00 → recovery closure 4h.
    recoveryTicketId = (await prisma.ticket.create({
      data: { workType: 'RECOVERY', status: 'RECEIVED_AT_WAREHOUSE', deviceId, plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: at(1), createdAt: at(1) },
    })).ticketId;
    ticketIds.push(recoveryTicketId);
    await prisma.ticketEvent.create({ data: { ticketId: recoveryTicketId, toState: 'RECEIVED_AT_WAREHOUSE', at: at(5) } });

    // Auto-assignment: Morning-Batch recommendation. Manual assignment: CRITICAL_ASSIGN audit on the ticket.
    await prisma.recommendation.create({ data: { ticketId: tsTicketId, seId: se, status: 'SUGGESTED', path: 'MORNING_BATCH', scoreBreakdown: {}, createdAt: at(2, 40) } });
    await prisma.auditLog.create({ data: { actorId: se, actorRole: 'ZONAL_MANAGER', action: 'CRITICAL_ASSIGN', entityType: 'ticket', entityId: tsTicketId, createdAt: at(2, 50) } });

    // Assignment chain: schedule + batch + batch-ticket (assignment 02:45) + ON_SITE soft state (03:00).
    const schedule = await prisma.workSchedule.create({ data: { seId: se, zoneId, dateFrom: at(0), dateTo: at(0), dispatchedAt: at(2) } });
    batchId = (await prisma.plantBatchAssignment.create({ data: { scheduleId: schedule.scheduleId, plantId, seId: se, status: 'AUTO_ASSIGNED', stopSequence: 1, createdAt: at(2, 45) } })).batchId;
    await prisma.batchAssignmentTicket.create({ data: { batchId, ticketId: tsTicketId, sortOrder: 1, createdAt: at(2, 45) } });
    await prisma.softState.create({ data: { ticketId: tsTicketId, seId: se, type: 'ON_SITE', setAt: at(3) } });

    // Override audit on the batch.
    await prisma.auditLog.create({ data: { actorId: se, actorRole: 'ZONAL_MANAGER', action: 'BATCH_OVERRIDE_REMOVE_TICKET', entityType: 'plant_batch_assignment', entityId: String(batchId), createdAt: at(3, 30) } });

    // Verification runs: a failed verification (04:00→04:10) and an auto-recovery (05:00→05:05).
    await prisma.verificationRun.create({ data: { ticketId: tsTicketId, deviceId, startedAt: at(4), outcome: 'FAILED_VERIFICATION', outcomeAt: at(4, 10) } });
    await prisma.verificationRun.create({ data: { ticketId: tsTicketId, deviceId, startedAt: at(5), outcome: 'CLOSED_AUTO_RECOVERY', outcomeAt: at(5, 5) } });

    // Auto-escalation: a Platinum cross-zone escalation raised in the day.
    await prisma.crossZoneEscalation.create({ data: { ticketId: tsTicketId, homeZoneId: zoneId, companyTier: 'PLATINUM', escalationType: 'AUTO_PLATINUM', status: 'PENDING', createdAt: at(7) } });
  });

  afterAll(async () => {
    await prisma.systemEfficiencySummaryDaily.deleteMany({ where: { zoneId } });
    await prisma.crossZoneEscalation.deleteMany({ where: { homeZoneId: zoneId } });
    await prisma.verificationRun.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.softState.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.batchAssignmentTicket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.plantBatchAssignment.deleteMany({ where: { plantId } });
    await prisma.workSchedule.deleteMany({ where: { zoneId } });
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [...ticketIds, String(batchId)] } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId } });
    await prisma.deviceState.deleteMany({ where: { deviceId } });
    await prisma.device.deleteMany({ where: { deviceId } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  const ohScope = { role: 'OPERATIONS_HEAD', zoneId: null };

  it('recomputes the day and the report shows the seeded efficiency metrics', async () => {
    const res = await agg.computeDay(new Date(DAY + 'T00:00:00Z'));
    expect(res.day).toBe(DAY);
    expect(res.rows).toBeGreaterThanOrEqual(1);

    const report = await reports.systemEfficiency(ohScope, { from: DAY, to: DAY, zoneId: Number(zoneId) });
    const f = report.fleet;

    expect(f.failureCyclesOpened).toBe(1);
    expect(f.ticketsCreated).toBe(2); // troubleshoot + recovery
    expect(f.troubleshootTicketsCreated).toBe(1);
    expect(f.autoAssignments).toBe(1);
    expect(f.manualAssignments).toBe(1);
    expect(f.overrides).toBe(1);
    expect(f.autoAssignmentRatePct).toBe(50);
    expect(f.manualAssignmentRatePct).toBe(50);

    expect(f.cyclesResolved).toBe(1);
    expect(f.verifiedCycles).toBe(1);
    expect(f.firstTimeFixes).toBe(1);
    expect(f.failedVerifications).toBe(1);
    expect(f.autoRecoveries).toBe(1);
    expect(f.autoEscalations).toBe(1);
    expect(f.slaCompliancePct).toBe(100);

    expect(f.totalDowntimeSeconds).toBe(14400);
    expect(f.avgDowntimeSeconds).toBe(14400);
    expect(f.avgDetectionToTicketSeconds).toBe(1800);
    expect(f.avgTicketToAssignmentSeconds).toBe(900);
    expect(f.avgAssignmentToOnsiteSeconds).toBe(900);
    expect(f.avgSubmissionToVerificationSeconds).toBe(450); // (600 + 300) / 2
    expect(f.avgRecoveryClosureSeconds).toBe(14400);
  });

  it('breaks out per zone (auto-escalations per zone) and applies filters', async () => {
    const report = await reports.systemEfficiency(ohScope, { from: DAY, to: DAY });
    const zoneRow = report.byZone.find((r) => r.zoneId === String(zoneId));
    expect(zoneRow).toBeDefined();
    expect(zoneRow!.autoEscalations).toBe(1);

    // device-type filter keeps the row; a non-matching device type empties it.
    const matched = await reports.systemEfficiency(ohScope, { from: DAY, to: DAY, zoneId: Number(zoneId), deviceType: 'GPS-EFF' });
    expect(matched.fleet.failureCyclesOpened).toBe(1);
    const missed = await reports.systemEfficiency(ohScope, { from: DAY, to: DAY, zoneId: Number(zoneId), deviceType: 'NOPE' });
    expect(missed.fleet.failureCyclesOpened).toBe(0);
  });

  it('a ZM is restricted to their own zone', async () => {
    const otherZm = { role: 'ZONAL_MANAGER', zoneId: Number(zoneId) + 99999 };
    const report = await reports.systemEfficiency(otherZm, { from: DAY, to: DAY });
    expect(report.fleet.failureCyclesOpened).toBe(0);
    expect(report.filters.zoneId).toBe(Number(zoneId) + 99999);
  });

  it('recompute is idempotent (second run yields identical totals)', async () => {
    await agg.computeDay(new Date(DAY + 'T00:00:00Z'));
    await agg.computeDay(new Date(DAY + 'T00:00:00Z'));
    const report = await reports.systemEfficiency(ohScope, { from: DAY, to: DAY, zoneId: Number(zoneId) });
    expect(report.fleet.failureCyclesOpened).toBe(1);
    expect(report.fleet.autoAssignments).toBe(1);
    expect(report.fleet.overrides).toBe(1);
  });
});
