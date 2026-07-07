import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { BusinessSweepSchedulerService } from '../src/scheduling/business-sweep-scheduler.service';
import { InstallLifecycleService } from '../src/ticketing/install-lifecycle.service';
import type { InstallNotifier } from '../src/ticketing/install-notifier';
import type { CrossZoneEscalationService } from '../src/cross-zone/cross-zone-escalation.service';
import type { IntradayInsertionService } from '../src/intraday/intraday-insertion.service';
import type { FleetUptimeAggregationService } from '../src/reports/fleet-uptime-aggregation.service';
import type { RootCauseAnalyticsAggregationService } from '../src/reports/root-cause-aggregation.service';
import type { SoftInactiveCountService } from '../src/reports/soft-inactive-count.service';
import type { SystemEfficiencyAggregationService } from '../src/reports/system-efficiency-aggregation.service';
import type { ZmPerformanceAggregationService } from '../src/reports/zm-performance-aggregation.service';
import type { RepeatEscalationService } from '../src/ticketing/repeat-escalation.service';
import type { VerificationService } from '../src/verification/verification.service';

/**
 * Issue 108 AC#5(b) — an ACTIVATED install ticket whose device produces a first valid post-fitment
 * ping is closed by a SCHEDULER TICK (not the on-demand call). The scheduler wraps the real
 * InstallLifecycleService; the other nine sweeps are unused stubs. `runInstallVerification` scans ALL
 * ACTIVATED install tickets (the scheduler passes no ticketId filter — the production path), so the
 * fixture isolates its own device/ticket and asserts on that ticket.
 */
const NS = Date.now();
const T_ACT = new Date(Date.UTC(2026, 5, 26, 8, 0, 0));
const unused = <T>() => ({}) as unknown as T;

describe('Issue 108 AC#5(b) — install verification runs on the scheduler tick', () => {
  let prisma: PrismaService;
  let install: InstallLifecycleService;
  let scheduler: BusinessSweepSchedulerService;

  const verified: string[] = [];
  const spyNotifier: InstallNotifier = {
    installVerified: (e) => { verified.push(e.ticketId); },
    failedActivation: () => {},
  };

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let snapshotRunId: bigint;
  let deviceSeq = 9_355_000n;
  const createdTicketIds: string[] = [];

  const makeActivated = async (): Promise<{ ticketId: string; deviceId: string }> => {
    const deviceId = String(deviceSeq++);
    await prisma.device.create({ data: { deviceId, deviceType: 'GPS-X' } });
    const t = await prisma.ticket.create({
      data: {
        workType: 'INSTALL', status: 'ACTIVATED', deviceId, plantId, companyId, companyTier: 'GOLD',
        assignedSeId: randomUUID(), installTriggerSource: 'MANUAL_OPERATIONS',
        fittedGpsSerial: String(deviceId), fittedSimSerial: 'SIM-BSS', fittedAt: T_ACT, activatedAt: T_ACT,
        lastStateChangedAt: T_ACT,
      },
    });
    createdTicketIds.push(t.ticketId);
    return { ticketId: t.ticketId, deviceId };
  };

  const ping = (deviceId: string, at: Date) =>
    prisma.rawDeviceSnapshot.create({ data: { runId: snapshotRunId, deviceId, gpsDatetime: at, lat: 72.9, lon: 19.1 } });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    install = new InstallLifecycleService(prisma, new AuditService(prisma), spyNotifier);
    scheduler = new BusinessSweepSchedulerService(
      unused<VerificationService>(), unused<IntradayInsertionService>(), unused<CrossZoneEscalationService>(),
      install, unused<RepeatEscalationService>(), unused<SoftInactiveCountService>(),
      unused<FleetUptimeAggregationService>(), unused<RootCauseAnalyticsAggregationService>(),
      unused<ZmPerformanceAggregationService>(), unused<SystemEfficiencyAggregationService>(), { enabled: true },
    );

    zoneId = (await prisma.zone.create({ data: { name: 'Z-bssi-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-bssi-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-bssi-' + NS, zoneId } })).plantId;
    snapshotRunId = (await prisma.snapshotRun.create({ data: { status: 'SUCCESS', startedAt: T_ACT } })).runId;
  });

  afterAll(async () => {
    await prisma.rawDeviceSnapshot.deleteMany({ where: { runId: snapshotRunId } });
    await prisma.snapshotRun.deleteMany({ where: { runId: snapshotRunId } });
    await prisma.auditLog.deleteMany({ where: { entityType: 'tickets', entityId: { in: createdTicketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: createdTicketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: createdTicketIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { gte: '9355000', lt: '9356000' } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('first valid post-fitment ping → the scheduler tick CLOSES the ticket + fires verified push', async () => {
    const { ticketId, deviceId } = await makeActivated();
    await ping(deviceId, new Date(T_ACT.getTime() + 30 * 60_000));

    const outcome = await scheduler.installVerificationTick(new Date(T_ACT.getTime() + 60 * 60_000));
    expect(outcome).toEqual({ ran: true });

    const t = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    expect(t.status).toBe('CLOSED');
    expect(verified).toContain(ticketId);
  });

  it('is dormant when the master switch is off — an ACTIVATED ticket stays ACTIVATED', async () => {
    const off = new BusinessSweepSchedulerService(
      unused<VerificationService>(), unused<IntradayInsertionService>(), unused<CrossZoneEscalationService>(),
      install, unused<RepeatEscalationService>(), unused<SoftInactiveCountService>(),
      unused<FleetUptimeAggregationService>(), unused<RootCauseAnalyticsAggregationService>(),
      unused<ZmPerformanceAggregationService>(), unused<SystemEfficiencyAggregationService>(), { enabled: false },
    );
    const { ticketId, deviceId } = await makeActivated();
    await ping(deviceId, new Date(T_ACT.getTime() + 30 * 60_000));

    expect(await off.installVerificationTick(new Date(T_ACT.getTime() + 60 * 60_000))).toEqual({ ran: false, reason: 'DISABLED' });
    expect((await prisma.ticket.findUniqueOrThrow({ where: { ticketId } })).status).toBe('ACTIVATED');
  });
});
