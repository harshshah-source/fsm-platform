import { randomUUID } from 'node:crypto';
import { ReportsService } from '../src/reports/reports.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 43 slice 2 — `ReportsService.zmScorecard`. The ZM-wise comparison (metrics summed over the month
 * range) with override rate (overrides ÷ zone auto-assignments) and zone SLA compliance (time-weighted
 * over the range), the optional zone drill-down filter, and the per-ZM monthly trend. Read purely from
 * `zm_performance_summary_monthly`. Operations-Head only (gated at the controller).
 */
const NS = Date.now();
const MAY = new Date(Date.UTC(2026, 4, 1));
const JUN = new Date(Date.UTC(2026, 5, 1));
const MAY_SECONDS = 31 * 86_400;
const JUN_SECONDS = 30 * 86_400;

describe('Issue 43 slice 2 — ReportsService.zmScorecard', () => {
  let prisma: PrismaService;
  let service: ReportsService;

  let zoneA: bigint;
  let zoneB: bigint;
  let zmA: string;
  let zmB: string;
  const ids: bigint[] = [];
  const userIds: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new ReportsService(prisma);

    zoneA = (await prisma.zone.create({ data: { name: 'ZA-zsc-' + NS } })).zoneId;
    zoneB = (await prisma.zone.create({ data: { name: 'ZB-zsc-' + NS } })).zoneId;
    zmA = await makeZm(zoneA, 'AAA');
    zmB = await makeZm(zoneB, 'BBB');

    // ZM A, zone A: May overrides 6 / auto 10 / downtime 86400; June overrides 4 / auto 10 / downtime 0.
    await row(MAY, zoneA, zmA, { overridesTotal: 6, reassignments: 2, manualAssignments: 3, overrideAfterOnsite: 1, autoAssignedCount: 10, zoneEligibleDevices: 1, zoneDowntimeSeconds: 86_400n, zoneWindowSeconds: BigInt(MAY_SECONDS) });
    await row(JUN, zoneA, zmA, { overridesTotal: 4, reassignments: 1, manualAssignments: 0, overrideAfterOnsite: 0, autoAssignedCount: 10, zoneEligibleDevices: 1, zoneDowntimeSeconds: 0n, zoneWindowSeconds: BigInt(JUN_SECONDS) });
    // ZM B, zone B: May only.
    await row(MAY, zoneB, zmB, { overridesTotal: 1, reassignments: 0, manualAssignments: 1, overrideAfterOnsite: 0, autoAssignedCount: 4, zoneEligibleDevices: 1, zoneDowntimeSeconds: 0n, zoneWindowSeconds: BigInt(MAY_SECONDS) });
  });

  afterAll(async () => {
    await prisma.zmPerformanceSummaryMonthly.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: [zoneA, zoneB] } } });
    await prisma.onModuleDestroy();
  });

  async function makeZm(zoneId: bigint, tag: string): Promise<string> {
    const t = randomUUID().slice(0, 8);
    const u = await prisma.user.create({ data: { name: `ZM ${tag} ${t}`, role: 'ZONAL_MANAGER', phone: `zsc-${t}`, email: `zsc-${t}@zsc.test`, zoneId } });
    userIds.push(u.userId);
    return u.userId;
  }

  type Metrics = {
    overridesTotal: number; reassignments: number; manualAssignments: number; overrideAfterOnsite: number;
    autoAssignedCount: number; zoneEligibleDevices: number; zoneDowntimeSeconds: bigint; zoneWindowSeconds: bigint;
  };
  async function row(month: Date, zoneId: bigint, zmId: string, m: Metrics): Promise<void> {
    const r = await prisma.zmPerformanceSummaryMonthly.create({ data: { month, zoneId, zmId, ...m, computedAt: new Date() } });
    ids.push(r.id);
  }

  it('sums each ZM’s metrics over the range with override rate and zone SLA compliance', async () => {
    const report = await service.zmScorecard({ fromMonth: '2026-05', toMonth: '2026-06' });
    const a = report.rows.find((r) => r.zmId === zmA);
    expect(a?.overrides).toBe(10); // 6 + 4
    expect(a?.reassignments).toBe(3); // 2 + 1
    expect(a?.manualAssignments).toBe(3);
    expect(a?.overrideAfterOnsite).toBe(1);
    expect(a?.autoAssigned).toBe(20);
    expect(a?.overrideRatePct).toBe(50); // 10/20
    // zone SLA: 1 - 86400 / (MAY+JUN seconds) → 98.36%
    expect(a?.zoneSlaCompliancePct).toBe(Math.round((1 - 86_400 / (MAY_SECONDS + JUN_SECONDS)) * 100 * 100) / 100);
    expect(a?.zoneName).toContain('ZA-zsc-');
  });

  it('returns a per-ZM monthly trend', async () => {
    const report = await service.zmScorecard({ fromMonth: '2026-05', toMonth: '2026-06' });
    const a = report.trend.find((s) => s.zmId === zmA);
    expect(a?.points.map((p) => p.month)).toEqual(['2026-05-01', '2026-06-01']);
    expect(a?.points[0].overrides).toBe(6);
    expect(a?.points[1].overrides).toBe(4);
  });

  it('zone drill-down filters to one zone', async () => {
    const report = await service.zmScorecard({ fromMonth: '2026-05', toMonth: '2026-06', zoneId: Number(zoneB) });
    expect(report.rows.every((r) => r.zoneId === Number(zoneB))).toBe(true);
    expect(report.rows.find((r) => r.zmId === zmB)).toBeTruthy();
    expect(report.rows.find((r) => r.zmId === zmA)).toBeUndefined();
  });
});
