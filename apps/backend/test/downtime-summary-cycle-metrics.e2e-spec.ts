import { randomUUID } from 'node:crypto';
import { FleetUptimeAggregationService } from '../src/reports/fleet-uptime-aggregation.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 44 slice 1 — the Fleet Uptime worker also writes the per-(device, month) cycle-level aggregates the
 * Lifetime Downtime Trend reads: cycle count, repeat-failure count, longest episode, recover-seconds sum +
 * recovered cycles (for average time-to-recover), and component-related downtime. Cycle metrics are
 * attributed to the month the cycle OPENED in. (downtime_seconds keeps its time-weighted-overlap meaning.)
 */
const NS = Date.now();
const MAY = new Date(Date.UTC(2026, 4, 1));
const NOW = new Date(Date.UTC(2026, 5, 26, 12, 0, 0)); // May is complete → windowEnd = 1 Jun

describe('Issue 44 slice 1 — FleetUptimeAggregationService cycle metrics', () => {
  let prisma: PrismaService;
  let service: FleetUptimeAggregationService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let seId: string;
  let devSeq = 9_440_000n;
  const devices: bigint[] = [];
  const cycleIds: string[] = [];
  const ticketIds: string[] = [];
  const submissionIds: string[] = [];
  const requestIds: string[] = [];
  const userIds: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new FleetUptimeAggregationService(prisma);
    zoneId = (await prisma.zone.create({ data: { name: 'Z-dcm-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-dcm-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-dcm-' + NS, zoneId } })).plantId;
    const t = randomUUID().slice(0, 8);
    const u = await prisma.user.create({ data: { name: 'SE ' + t, role: 'SERVICE_ENGINEER', phone: 'dcm-' + t, email: `dcm-${t}@dcm.test`, zoneId } });
    seId = u.userId;
    userIds.push(seId);
    await prisma.engineerMaster.create({ data: { engineerId: seId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
  });

  afterAll(async () => {
    await prisma.deviceDowntimeSummaryMonthly.deleteMany({ where: { deviceId: { in: devices } } });
    await prisma.componentRequest.deleteMany({ where: { requestId: { in: requestIds } } });
    await prisma.troubleshootingSubmission.deleteMany({ where: { submissionId: { in: submissionIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { cycleId: { in: cycleIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: devices } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: devices } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  async function makeDevice(): Promise<bigint> {
    const deviceId = devSeq++;
    devices.push(deviceId);
    await prisma.device.create({ data: { deviceId, deviceType: 'GPS-X' } });
    await prisma.deviceState.create({ data: { deviceId, eligibleForUptime: true, plantId, companyId, computedAt: NOW } });
    return deviceId;
  }

  async function addCycle(deviceId: bigint, openedAt: Date, closedAt: Date | null, opts: { repeat?: boolean; withComponent?: boolean } = {}): Promise<string> {
    const cycle = await prisma.failureCycle.create({
      data: { deviceId, state: closedAt ? 'VERIFIED' : 'OPEN', openedAt, closedAt, repeatFailure: opts.repeat ?? false },
    });
    cycleIds.push(cycle.cycleId);
    if (opts.withComponent) {
      const ticket = await prisma.ticket.create({
        data: { workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: cycle.cycleId, deviceId, plantId, companyId, companyTier: 'GOLD', lastStateChangedAt: openedAt },
      });
      ticketIds.push(ticket.ticketId);
      const sub = await prisma.troubleshootingSubmission.create({
        data: { ticketId: ticket.ticketId, failureCycleId: cycle.cycleId, submissionType: 'TROUBLESHOOTING_FORM', clientSubmissionId: randomUUID(), seId, presenceSource: 'NONE', rootCauseCategory: 'POWER_ISSUE', submittedAt: openedAt },
      });
      submissionIds.push(sub.submissionId);
      const req = await prisma.componentRequest.create({
        data: { ticketId: ticket.ticketId, failureCycleId: cycle.cycleId, submissionId: sub.submissionId, seId, status: 'REQUESTED' },
      });
      requestIds.push(req.requestId);
    }
    return cycle.cycleId;
  }

  const summaryFor = (deviceId: bigint) =>
    prisma.deviceDowntimeSummaryMonthly.findUniqueOrThrow({ where: { deviceId_month: { deviceId, month: MAY } } });

  it('counts cycles opened in the month, repeat-failures, longest episode and recover totals', async () => {
    const d = await makeDevice();
    await addCycle(d, new Date(Date.UTC(2026, 4, 5)), new Date(Date.UTC(2026, 4, 7))); // 2d, closed
    await addCycle(d, new Date(Date.UTC(2026, 4, 10)), new Date(Date.UTC(2026, 4, 14)), { repeat: true }); // 4d, closed, repeat
    await addCycle(d, new Date(Date.UTC(2026, 4, 20)), null); // open → runs to 1 Jun = 12d

    await service.computeMonth(MAY, NOW);
    const s = await summaryFor(d);
    expect(s.cycleCount).toBe(3);
    expect(s.repeatFailureCount).toBe(1);
    expect(Number(s.longestEpisodeSeconds)).toBe(12 * 86_400); // the open cycle, to window end
    expect(Number(s.recoverSecondsSum)).toBe((2 + 4) * 86_400); // closed cycles only
    expect(s.recoveredCycles).toBe(2);
  });

  it('attributes component-related downtime to cycles that incurred a Component Request', async () => {
    const d = await makeDevice();
    await addCycle(d, new Date(Date.UTC(2026, 4, 3)), new Date(Date.UTC(2026, 4, 6)), { withComponent: true }); // 3d, component
    await addCycle(d, new Date(Date.UTC(2026, 4, 8)), new Date(Date.UTC(2026, 4, 9))); // 1d, no component

    await service.computeMonth(MAY, NOW);
    const s = await summaryFor(d);
    expect(Number(s.componentDowntimeSeconds)).toBe(3 * 86_400);
  });

  it('attributes cycle metrics to the OPEN month (a cycle opened in April is not counted in May)', async () => {
    const d = await makeDevice();
    await addCycle(d, new Date(Date.UTC(2026, 3, 28)), new Date(Date.UTC(2026, 4, 3))); // opened April, closed May
    await service.computeMonth(MAY, NOW);
    const s = await summaryFor(d);
    expect(s.cycleCount).toBe(0); // opened in April → not a May cycle
    expect(Number(s.downtimeSeconds)).toBe(2 * 86_400); // but its May overlap still counts as downtime
  });
});
