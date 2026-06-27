import { ReportsService } from '../src/reports/reports.service';
import { PrismaService } from '../src/prisma/prisma.service';
import type { RootCauseCategory } from '../src/generated/prisma/client';

/**
 * Issue 41 slice 2 — `ReportsService.rootCause`. The Root Cause Analytics read: the % distribution of
 * device-inactivity root causes over `root_cause_summary_monthly` (never raw scans, never free-text).
 * Every documented category is represented (zero-filled). Filterable by Zone / Company / Plant / device
 * type / SE / month range. A ZONAL_MANAGER is scoped to their own zone; CSM / Operations Head see all.
 */
const NS = Date.now();
const MAY = new Date(Date.UTC(2026, 4, 1));
const SE_A = '11111111-1111-1111-1111-111111111111';
const SE_B = '22222222-2222-2222-2222-222222222222';

describe('Issue 41 slice 2 — ReportsService.rootCause', () => {
  let prisma: PrismaService;
  let service: ReportsService;

  let zoneId: bigint;
  let otherZoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  const ids: bigint[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new ReportsService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-rcr-' + NS } })).zoneId;
    otherZoneId = (await prisma.zone.create({ data: { name: 'Z-rcr2-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-rcr-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-rcr-' + NS, zoneId } })).plantId;

    // 6 POWER + 2 SIM (SE A, GPS-X) and 2 GPS_ANTENNA (SE B, GPS-Y) in the target zone → total 10.
    await summary('POWER_ISSUE', 6, SE_A, 'GPS-X');
    await summary('SIM_NETWORK_ISSUE', 2, SE_A, 'GPS-X');
    await summary('GPS_ANTENNA_ISSUE', 2, SE_B, 'GPS-Y');
    // A row in another zone — a ZM scoped to `zoneId` must never see it.
    await summary('UNKNOWN', 99, SE_A, 'GPS-X', otherZoneId);
  });

  afterAll(async () => {
    await prisma.rootCauseSummaryMonthly.deleteMany({ where: { id: { in: ids } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: [zoneId, otherZoneId] } } });
    await prisma.onModuleDestroy();
  });

  async function summary(category: RootCauseCategory, count: number, seId: string, deviceType: string, zone = zoneId): Promise<void> {
    const row = await prisma.rootCauseSummaryMonthly.create({
      data: {
        month: MAY,
        zoneId: zone,
        companyId,
        plantId,
        deviceType,
        seId,
        rootCauseCategory: category,
        submissionCount: count,
        computedAt: new Date(),
      },
    });
    ids.push(row.id);
  }

  const ALL = { role: 'OPERATIONS_HEAD', zoneId: null };
  const range = { fromMonth: '2026-05', toMonth: '2026-05' };

  it('returns the % distribution with every documented category zero-filled', async () => {
    const r = await service.rootCause(ALL, { ...range, zoneId: Number(zoneId) });
    expect(r.totalSubmissions).toBe(10);
    expect(r.distribution).toHaveLength(10); // all documented categories
    const byCat = Object.fromEntries(r.distribution.map((d) => [d.category, d]));
    expect(byCat.POWER_ISSUE.count).toBe(6);
    expect(byCat.POWER_ISSUE.pct).toBe(60);
    expect(byCat.SIM_NETWORK_ISSUE.pct).toBe(20);
    expect(byCat.GPS_ANTENNA_ISSUE.pct).toBe(20);
    expect(byCat.DEVICE_HARDWARE_FAULT.count).toBe(0);
    expect(byCat.DEVICE_HARDWARE_FAULT.pct).toBe(0);
  });

  it('filters by SE', async () => {
    const r = await service.rootCause(ALL, { ...range, zoneId: Number(zoneId), seId: SE_B });
    expect(r.totalSubmissions).toBe(2);
    const byCat = Object.fromEntries(r.distribution.map((d) => [d.category, d]));
    expect(byCat.GPS_ANTENNA_ISSUE.pct).toBe(100);
    expect(byCat.POWER_ISSUE.count).toBe(0);
  });

  it('filters by device type', async () => {
    const r = await service.rootCause(ALL, { ...range, zoneId: Number(zoneId), deviceType: 'GPS-Y' });
    expect(r.totalSubmissions).toBe(2);
    expect(Object.fromEntries(r.distribution.map((d) => [d.category, d.count])).GPS_ANTENNA_ISSUE).toBe(2);
  });

  it('a ZM is scoped to their own zone, ignoring other zones', async () => {
    const zm = { role: 'ZONAL_MANAGER', zoneId: Number(zoneId) };
    const r = await service.rootCause(zm, range); // no zone filter passed — scope pins it
    expect(r.totalSubmissions).toBe(10); // the other zone's 99 UNKNOWN excluded
    expect(Object.fromEntries(r.distribution.map((d) => [d.category, d.count])).UNKNOWN).toBe(0);
  });
});
