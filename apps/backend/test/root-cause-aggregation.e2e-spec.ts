import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { RootCauseAnalyticsAggregationService } from '../src/reports/root-cause-aggregation.service';
import type { RootCauseCategory } from '../src/generated/prisma/client';

/**
 * Issue 41 slice 1 — the Root Cause Analytics aggregation worker. `computeMonth(month, now)` rebuilds
 * `root_cause_summary_monthly` for the month: one row per (month, zone, company, plant, device_type, SE,
 * root_cause_category) holding the count of structured-root-cause troubleshooting submissions in that
 * bucket. The count comes from the structured `root_cause_category` only — never parsed from free-text
 * diagnosis notes. Rebuild is idempotent (delete + insert per month).
 */
const NS = Date.now();
const MAY = new Date(Date.UTC(2026, 4, 1)); // May 2026
const NOW = new Date(Date.UTC(2026, 5, 26, 12, 0, 0)); // 26 Jun 2026

describe('Issue 41 slice 1 — RootCauseAnalyticsAggregationService.computeMonth', () => {
  let prisma: PrismaService;
  let service: RootCauseAnalyticsAggregationService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let se: string;
  let seB: string;
  let devSeq = 9_410_000n;
  const devices: bigint[] = [];
  const cycleIds: string[] = [];
  const ticketIds: string[] = [];
  const submissionIds: string[] = [];
  const userIds: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new RootCauseAnalyticsAggregationService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-rca-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-rca-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-rca-' + NS, zoneId } })).plantId;
    se = await makeEngineer('A');
    seB = await makeEngineer('B');
  });

  afterAll(async () => {
    await prisma.rootCauseSummaryMonthly.deleteMany({ where: { zoneId } });
    await prisma.troubleshootingSubmission.deleteMany({ where: { submissionId: { in: submissionIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { cycleId: { in: cycleIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: devices } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  async function makeEngineer(tag: string): Promise<string> {
    const t = randomUUID().slice(0, 8);
    const user = await prisma.user.create({
      data: { name: `SE ${tag} ${t}`, role: 'SERVICE_ENGINEER', phone: `rca-${t}`, email: `rca-${t}@rca.test`, zoneId },
    });
    userIds.push(user.userId);
    await prisma.engineerMaster.create({ data: { engineerId: user.userId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
    return user.userId;
  }

  /** One troubleshooting submission carrying a structured root cause, on a device of `deviceType`. */
  async function addSubmission(opts: {
    category: RootCauseCategory;
    submittedAt: Date;
    seId?: string;
    deviceType?: string | null;
  }): Promise<void> {
    const deviceId = devSeq++;
    devices.push(deviceId);
    await prisma.device.create({ data: { deviceId, deviceType: opts.deviceType ?? null } });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: opts.submittedAt } });
    cycleIds.push(cycle.cycleId);
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        failureCycleId: cycle.cycleId,
        deviceId,
        plantId,
        companyId,
        companyTier: 'GOLD',
        lastStateChangedAt: opts.submittedAt,
      },
    });
    ticketIds.push(ticket.ticketId);
    const sub = await prisma.troubleshootingSubmission.create({
      data: {
        ticketId: ticket.ticketId,
        failureCycleId: cycle.cycleId,
        submissionType: 'TROUBLESHOOTING_FORM',
        clientSubmissionId: randomUUID(),
        seId: opts.seId ?? se,
        presenceSource: 'NONE',
        rootCauseCategory: opts.category,
        submittedAt: opts.submittedAt,
      },
    });
    submissionIds.push(sub.submissionId);
  }

  const rowsForZone = () =>
    prisma.rootCauseSummaryMonthly.findMany({ where: { zoneId, month: MAY }, orderBy: { rootCauseCategory: 'asc' } });

  it('aggregates structured root-cause counts per category with full dimension context', async () => {
    await addSubmission({ category: 'POWER_ISSUE', submittedAt: new Date(Date.UTC(2026, 4, 5)), deviceType: 'GPS-X' });
    await addSubmission({ category: 'POWER_ISSUE', submittedAt: new Date(Date.UTC(2026, 4, 9)), deviceType: 'GPS-X' });
    await addSubmission({ category: 'SIM_NETWORK_ISSUE', submittedAt: new Date(Date.UTC(2026, 4, 12)), deviceType: 'GPS-X' });

    await service.computeMonth(MAY, NOW);

    const rows = await rowsForZone();
    const power = rows.find((r) => r.rootCauseCategory === 'POWER_ISSUE');
    const sim = rows.find((r) => r.rootCauseCategory === 'SIM_NETWORK_ISSUE');
    expect(power?.submissionCount).toBe(2);
    expect(sim?.submissionCount).toBe(1);
    expect(power?.zoneId).toBe(zoneId);
    expect(power?.companyId).toBe(companyId);
    expect(power?.plantId).toBe(plantId);
    expect(power?.deviceType).toBe('GPS-X');
    expect(power?.seId).toBe(se);
  });

  it('is idempotent — recomputing the month rebuilds, never duplicates', async () => {
    await service.computeMonth(MAY, NOW);
    await service.computeMonth(MAY, NOW);
    const power = (await rowsForZone()).filter((r) => r.rootCauseCategory === 'POWER_ISSUE' && r.seId === se);
    expect(power).toHaveLength(1);
    expect(power[0].submissionCount).toBe(2);
  });

  it('counts only submissions whose submitted_at falls in the month', async () => {
    await addSubmission({ category: 'WIRING_ISSUE', submittedAt: new Date(Date.UTC(2026, 3, 28)), deviceType: 'GPS-X' }); // April
    await addSubmission({ category: 'WIRING_ISSUE', submittedAt: new Date(Date.UTC(2026, 5, 2)), deviceType: 'GPS-X' }); // June
    await addSubmission({ category: 'WIRING_ISSUE', submittedAt: new Date(Date.UTC(2026, 4, 15)), deviceType: 'GPS-X' }); // May
    await service.computeMonth(MAY, NOW);
    const wiring = (await rowsForZone()).find((r) => r.rootCauseCategory === 'WIRING_ISSUE');
    expect(wiring?.submissionCount).toBe(1);
  });

  it('separates rows per SE and carries a null device_type', async () => {
    await addSubmission({ category: 'CONFIGURATION_ISSUE', submittedAt: new Date(Date.UTC(2026, 4, 7)), seId: seB, deviceType: null });
    const result = await service.computeMonth(MAY, NOW);
    const config = (await rowsForZone()).filter((r) => r.rootCauseCategory === 'CONFIGURATION_ISSUE');
    expect(config).toHaveLength(1);
    expect(config[0].seId).toBe(seB);
    expect(config[0].deviceType).toBeNull();
    // result.submissions is the full month total across every bucket
    expect(result.submissions).toBe((await rowsForZone()).reduce((s, r) => s + r.submissionCount, 0));
  });
});
