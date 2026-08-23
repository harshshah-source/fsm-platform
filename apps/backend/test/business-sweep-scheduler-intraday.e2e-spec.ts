import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import { SeAvailabilityService } from '../src/engineers/se-availability.service';
import { ACCEPTANCE_TIMEOUT_MIN, IntradayInsertionService } from '../src/intraday/intraday-insertion.service';
import { NotificationService } from '../src/notifications/notification.service';
import { alwaysClaims } from './support/tick-claims';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { BusinessSweepSchedulerService } from '../src/scheduling/business-sweep-scheduler.service';
import { LoggingDayPlanNotifier } from '../src/scheduling/day-plan-notifier';
import { OverrideService } from '../src/scheduling/override.service';
import type { CrossZoneEscalationService } from '../src/cross-zone/cross-zone-escalation.service';
import type { TierOverrideExpiryService } from '../src/org/tier-override-expiry.service';
import type { FleetUptimeAggregationService } from '../src/reports/fleet-uptime-aggregation.service';
import type { RootCauseAnalyticsAggregationService } from '../src/reports/root-cause-aggregation.service';
import type { SoftInactiveCountService } from '../src/reports/soft-inactive-count.service';
import type { SystemEfficiencyAggregationService } from '../src/reports/system-efficiency-aggregation.service';
import type { ZmPerformanceAggregationService } from '../src/reports/zm-performance-aggregation.service';
import type { InstallLifecycleService } from '../src/ticketing/install-lifecycle.service';
import type { RepeatEscalationService } from '../src/ticketing/repeat-escalation.service';
import type { VerificationService } from '../src/verification/verification.service';

/**
 * Issue 108 AC#5(a) — the regression the whole scheduler exists for: an intra-day CRITICAL offer is
 * created, the clock advances past ACCEPTANCE_TIMEOUT_MIN, and a SCHEDULER TICK (not the
 * `POST /api/intraday-insertions/sweep-timeouts` controller) reroutes the offer to the next-best SE.
 * The scheduler wraps the real IntradayInsertionService; the other nine sweeps are unused stubs.
 */
const NS = Date.now();
const BASE = new Date('2026-06-28T06:00:00Z');
const afterDeadline = (offeredAt: Date) => new Date(offeredAt.getTime() + (ACCEPTANCE_TIMEOUT_MIN + 1) * 60_000);
const unused = <T>() => ({}) as unknown as T;

describe('Issue 108 AC#5(a) — intraday acceptance-timeout runs on the scheduler tick', () => {
  let prisma: PrismaService;
  let intraday: IntradayInsertionService;
  let scheduler: BusinessSweepSchedulerService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];

  const makeSe = async (): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@bss.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({ data: { engineerId: u.userId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
    await prisma.seCoverage.create({ data: { seId: u.userId, plantId, coverageType: 'DEDICATED' } });
    return u.userId;
  };

  const makeCriticalTicket = async (): Promise<string> => {
    const deviceId = String(11_760_000_000 + ((NS + deviceIds.length) % 100_000) + deviceIds.length);
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
      data: { workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: cycle.cycleId, deviceId, plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: BASE },
    });
    ticketIds.push(t.ticketId);
    return t.ticketId;
  };

  const latestInsertion = (ticketId: string) =>
    prisma.intradayInsertion.findFirstOrThrow({ where: { ticketId }, orderBy: { insertionId: 'desc' } });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    intraday = new IntradayInsertionService(
      prisma,
      new CandidateSelectionService(prisma),
      new OverrideService(prisma, new AuditService(prisma), new LoggingDayPlanNotifier()),
      new NotificationService(prisma),
      new SeAvailabilityService(prisma),
      new AuditService(prisma),
    );
    scheduler = new BusinessSweepSchedulerService(
      unused<VerificationService>(),
      intraday,
      unused<CrossZoneEscalationService>(),
      unused<InstallLifecycleService>(),
      unused<RepeatEscalationService>(),
      unused<TierOverrideExpiryService>(),
      unused<SoftInactiveCountService>(),
      unused<FleetUptimeAggregationService>(),
      unused<RootCauseAnalyticsAggregationService>(),
      unused<ZmPerformanceAggregationService>(),
      unused<SystemEfficiencyAggregationService>(),
      alwaysClaims(),
      { enabled: true },
    );

    const zm = await prisma.user.create({
      data: { name: 'ZM ' + NS, role: 'ZONAL_MANAGER', phone: 'zm-bss-' + NS, email: `zm-bss-${NS}@bss.test` },
    });
    userIds.push(zm.userId);
    zoneId = (await prisma.zone.create({ data: { name: 'Z-bss-' + NS, zonalManagerUserId: zm.userId } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-bss-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-bss-' + NS, zoneId } })).plantId;
    for (let i = 0; i < 3; i++) await makeSe();
  });

  afterAll(async () => {
    await prisma.intradayInsertion.deleteMany({ where: { zoneId } });
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

  it('offer past its acceptance deadline is rerouted to the next-best SE when the scheduler tick fires', async () => {
    const ticketId = await makeCriticalTicket();
    await intraday.fireForZone(zoneId, BASE);
    const ins = await latestInsertion(ticketId);
    const firstOfferedTo = ins.offeredSeId;
    expect(ins.status).toBe('PENDING_ACCEPTANCE');

    // The scheduler tick drives the sweep with an injected clock past the deadline — no HTTP call.
    const outcome = await scheduler.intradayTimeoutTick(afterDeadline(ins.offeredAt));
    expect(outcome).toEqual({ ran: true });

    const after = await prisma.intradayInsertion.findUniqueOrThrow({ where: { insertionId: ins.insertionId } });
    expect(after.status).toBe('PENDING_ACCEPTANCE');
    expect(after.offeredSeId).not.toBe(firstOfferedTo);
    expect(after.retryCount).toBe(1);
    expect((after.retryChain as Array<{ outcome: string }>)[0].outcome).toBe('TIMED_OUT');
  });

  it('is dormant when the master switch is off — a stale offer is left untouched', async () => {
    const off = new BusinessSweepSchedulerService(
      unused<VerificationService>(), intraday, unused<CrossZoneEscalationService>(), unused<InstallLifecycleService>(),
      unused<RepeatEscalationService>(), unused<TierOverrideExpiryService>(), unused<SoftInactiveCountService>(),
      unused<FleetUptimeAggregationService>(), unused<RootCauseAnalyticsAggregationService>(),
      unused<ZmPerformanceAggregationService>(), unused<SystemEfficiencyAggregationService>(), alwaysClaims(),
      { enabled: false },
    );
    const ticketId = await makeCriticalTicket();
    await intraday.fireForZone(zoneId, BASE);
    const ins = await latestInsertion(ticketId);

    expect(await off.intradayTimeoutTick(afterDeadline(ins.offeredAt))).toEqual({ ran: false, reason: 'DISABLED' });

    const after = await prisma.intradayInsertion.findUniqueOrThrow({ where: { insertionId: ins.insertionId } });
    expect(after.offeredSeId).toBe(ins.offeredSeId);
    expect(after.retryCount).toBe(0);
  });
});
