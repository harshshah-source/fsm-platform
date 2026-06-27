import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { DeviceDetailService } from '../src/devices/device-detail.service';

/**
 * Issue 44 slice 3 — `DeviceDetailService.downtimeTrend`. The Lifetime Downtime Trend: monthly downtime
 * hours / cycle count / repeat-failure / auto-vs-SE split / component-related downtime + average
 * time-to-recover, longest episode, and a per-device root-cause trend. The monthly series is read from
 * `device_downtime_summary_monthly` (never a multi-year raw scan); the per-device root-cause trend is a
 * bounded read of that one device's submissions. ZM zone-scoped; CSM / Operations Head see any device.
 */
const NS = Date.now();
const MAY = new Date(Date.UTC(2026, 4, 1));
const JUN = new Date(Date.UTC(2026, 5, 1));

describe('Issue 44 slice 3 — DeviceDetailService.downtimeTrend', () => {
  let prisma: PrismaService;
  let service: DeviceDetailService;

  let zoneA: bigint;
  let zoneB: bigint;
  let companyId: bigint;
  let plantA: bigint;
  let seId: string;
  let deviceId: bigint;
  const userIds: string[] = [];
  const cycleIds: string[] = [];
  const ticketIds: string[] = [];
  const submissionIds: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new DeviceDetailService(prisma);

    zoneA = (await prisma.zone.create({ data: { name: 'ZA-dt-' + NS } })).zoneId;
    zoneB = (await prisma.zone.create({ data: { name: 'ZB-dt-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-dt-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantA = (await prisma.plant.create({ data: { name: 'PA-dt-' + NS, zoneId: zoneA } })).plantId;
    const t = randomUUID().slice(0, 8);
    const u = await prisma.user.create({ data: { name: 'SE ' + t, role: 'SERVICE_ENGINEER', phone: 'dt-' + t, email: `dt-${t}@dt.test`, zoneId: zoneA } });
    seId = u.userId;
    userIds.push(seId);
    await prisma.engineerMaster.create({ data: { engineerId: seId, coverageType: 'DEDICATED', zoneId: zoneA, dailyCapacity: 10 } });

    deviceId = BigInt(9_446_000_000 + (NS % 100_000));
    await prisma.device.create({ data: { deviceId, deviceType: 'GPS-X' } });
    await prisma.deviceState.create({ data: { deviceId, eligibleForUptime: true, plantId: plantA, companyId, computedAt: MAY } });

    await summary(MAY, { downtimeSeconds: 2n * 86_400n, cycleCount: 2, repeatFailureCount: 1, autoRecoveryClosures: 1, seRepairedClosures: 1, componentDowntimeSeconds: 86_400n, recoverSecondsSum: 3n * 86_400n, recoveredCycles: 2, longestEpisodeSeconds: 2n * 86_400n });
    await summary(JUN, { downtimeSeconds: 0n, cycleCount: 1, repeatFailureCount: 0, autoRecoveryClosures: 0, seRepairedClosures: 0, componentDowntimeSeconds: 0n, recoverSecondsSum: 5n * 86_400n, recoveredCycles: 1, longestEpisodeSeconds: 5n * 86_400n });

    // Submissions for the per-device root-cause trend: 2 POWER + 1 SIM in May.
    await rcSubmission('POWER_ISSUE', new Date(Date.UTC(2026, 4, 4)));
    await rcSubmission('POWER_ISSUE', new Date(Date.UTC(2026, 4, 9)));
    await rcSubmission('SIM_NETWORK_ISSUE', new Date(Date.UTC(2026, 4, 14)));
  });

  afterAll(async () => {
    await prisma.deviceDowntimeSummaryMonthly.deleteMany({ where: { deviceId } });
    await prisma.troubleshootingSubmission.deleteMany({ where: { submissionId: { in: submissionIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { cycleId: { in: cycleIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId } });
    await prisma.device.deleteMany({ where: { deviceId } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId: plantA } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: [zoneA, zoneB] } } });
    await prisma.onModuleDestroy();
  });

  type S = Parameters<typeof prisma.deviceDowntimeSummaryMonthly.create>[0]['data'];
  async function summary(month: Date, m: Partial<S>): Promise<void> {
    await prisma.deviceDowntimeSummaryMonthly.create({
      data: { deviceId, month, zoneId: zoneA, companyId, plantId: plantA, eligible: true, windowSeconds: 0n, computedAt: month, ...m },
    });
  }

  async function rcSubmission(category: 'POWER_ISSUE' | 'SIM_NETWORK_ISSUE', at: Date): Promise<void> {
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'VERIFIED', openedAt: at, closedAt: new Date(at.getTime() + 3_600_000) } });
    cycleIds.push(cycle.cycleId);
    const ticket = await prisma.ticket.create({ data: { workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: cycle.cycleId, deviceId, plantId: plantA, companyId, companyTier: 'GOLD', lastStateChangedAt: at } });
    ticketIds.push(ticket.ticketId);
    const sub = await prisma.troubleshootingSubmission.create({ data: { ticketId: ticket.ticketId, failureCycleId: cycle.cycleId, submissionType: 'TROUBLESHOOTING_FORM', clientSubmissionId: randomUUID(), seId, presenceSource: 'NONE', rootCauseCategory: category, submittedAt: at } });
    submissionIds.push(sub.submissionId);
  }

  const oh = { role: 'OPERATIONS_HEAD', zoneId: null };

  it('aggregates lifetime totals and a monthly series from the summary', async () => {
    const out = await service.downtimeTrend(deviceId, oh);
    expect(out.result).toBe('OK');
    if (out.result !== 'OK') return;
    const { lifetime, monthly } = out.trend;
    expect(lifetime.totalCycles).toBe(3);
    expect(lifetime.totalDowntimeHours).toBe(48); // 2 days
    expect(lifetime.repeatFailures).toBe(1);
    expect(lifetime.longestEpisodeHours).toBe(120); // max(2d, 5d) = 5 days
    expect(lifetime.avgTimeToRecoverHours).toBe(64); // (3d + 5d) / 3 cycles = 64h
    expect(lifetime.autoRecoveryClosures).toBe(1);
    expect(lifetime.seRepairedClosures).toBe(1);

    expect(monthly.map((m) => m.month)).toEqual(['2026-05-01', '2026-06-01']);
    const may = monthly[0];
    expect(may.downtimeHours).toBe(48);
    expect(may.componentDowntimeHours).toBe(24);
    expect(may.avgTimeToRecoverHours).toBe(36); // 3d / 2 cycles = 36h
  });

  it('includes a per-device root-cause trend', async () => {
    const out = await service.downtimeTrend(deviceId, oh);
    if (out.result !== 'OK') return;
    const may = out.trend.rootCauseTrend.filter((r) => r.month === '2026-05-01');
    const byCat = Object.fromEntries(may.map((r) => [r.category, r.count]));
    expect(byCat.POWER_ISSUE).toBe(2);
    expect(byCat.SIM_NETWORK_ISSUE).toBe(1);
  });

  it('a ZM in another zone gets NOT_FOUND', async () => {
    const out = await service.downtimeTrend(deviceId, { role: 'ZONAL_MANAGER', zoneId: Number(zoneB) });
    expect(out.result).toBe('NOT_FOUND');
  });
});
