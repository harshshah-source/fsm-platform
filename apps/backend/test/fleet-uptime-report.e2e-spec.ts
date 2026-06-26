import { ReportsService } from '../src/reports/reports.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 39 slice 2 — the Fleet Uptime report read (AC#1/#2/#3/#5). Reads only
 * `device_downtime_summary_monthly` (never raw telemetry). Uptime% is time-weighted
 * (1 − Σdowntime/Σwindow) over the **Eligible Devices** denominator; ineligible rows are excluded.
 * Breakdown per zone / company / plant; a ZM is scoped to their own zone. Auto-recovery and
 * SE-repaired closures are surfaced separately.
 */
const NS = Date.now();
const MONTH = new Date(Date.UTC(2026, 4, 1)); // May 2026
const W = 1000; // window seconds per device (round numbers for easy math)

describe('Issue 39 slice 2 — ReportsService.fleetUptime', () => {
  let prisma: PrismaService;
  let service: ReportsService;

  let zoneA: bigint;
  let zoneB: bigint;
  let companyId: bigint;
  let plantA: bigint;
  let plantB: bigint;
  let devSeq = 9_391_000n;
  const devices: bigint[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new ReportsService(prisma);

    zoneA = (await prisma.zone.create({ data: { name: 'Z-fur-A-' + NS } })).zoneId;
    zoneB = (await prisma.zone.create({ data: { name: 'Z-fur-B-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-fur-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantA = (await prisma.plant.create({ data: { name: 'P-fur-A-' + NS, zoneId: zoneA } })).plantId;
    plantB = (await prisma.plant.create({ data: { name: 'P-fur-B-' + NS, zoneId: zoneB } })).plantId;

    // zoneA: two eligible devices — downtime 100 + 0 over 2×1000 window → 95.0% uptime; 1 auto + 2 SE closures.
    await summary(zoneA, plantA, true, 100, 1, 2);
    await summary(zoneA, plantA, true, 0, 0, 0);
    // zoneA: an INELIGIBLE device with huge downtime — must be excluded from the denominator.
    await summary(zoneA, plantA, false, 900, 0, 0);
    // zoneB: one eligible device — downtime 500 over 1000 → 50.0% uptime.
    await summary(zoneB, plantB, true, 500, 0, 1);
  });

  async function summary(zoneId: bigint, plantId: bigint, eligible: boolean, downtime: number, auto: number, se: number): Promise<void> {
    const deviceId = devSeq++;
    devices.push(deviceId);
    await prisma.device.create({ data: { deviceId, deviceType: 'GPS-X' } });
    await prisma.deviceDowntimeSummaryMonthly.create({
      data: {
        deviceId, month: MONTH, zoneId, companyId, plantId, eligible,
        windowSeconds: BigInt(W), downtimeSeconds: BigInt(downtime),
        autoRecoveryClosures: auto, seRepairedClosures: se, computedAt: new Date(),
      },
    });
  }

  afterAll(async () => {
    await prisma.deviceDowntimeSummaryMonthly.deleteMany({ where: { deviceId: { in: devices } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: devices } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [plantA, plantB] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: [zoneA, zoneB] } } });
    await prisma.onModuleDestroy();
  });

  const ohScope = { role: 'OPERATIONS_HEAD', zoneId: null };

  it('groups by zone: eligible-only denominator, time-weighted uptime, closure split', async () => {
    const report = await service.fleetUptime(ohScope, { month: '2026-05', groupBy: 'zone' });
    expect(report.month).toBe('2026-05-01');
    expect(report.groupBy).toBe('zone');

    const a = report.rows.find((r) => r.id === String(zoneA));
    expect(a?.eligibleDeviceCount).toBe(2); // the ineligible device is excluded
    expect(a?.uptimePct).toBe(95); // (1 - 100/2000) * 100
    expect(a?.autoRecoveryClosures).toBe(1);
    expect(a?.seRepairedClosures).toBe(2);

    const b = report.rows.find((r) => r.id === String(zoneB));
    expect(b?.eligibleDeviceCount).toBe(1);
    expect(b?.uptimePct).toBe(50);
  });

  it('computes the fleet total over all eligible devices in scope', async () => {
    const report = await service.fleetUptime(ohScope, { month: '2026-05', groupBy: 'zone' });
    // 3 eligible devices, Σwindow=3000, Σdowntime=600 → (1 - 600/3000)*100 = 80.0
    expect(report.fleet.eligibleDeviceCount).toBe(3);
    expect(report.fleet.uptimePct).toBe(80);
    expect(report.fleet.autoRecoveryClosures).toBe(1);
    expect(report.fleet.seRepairedClosures).toBe(3);
  });

  it('groups by plant and by company', async () => {
    const byPlant = await service.fleetUptime(ohScope, { month: '2026-05', groupBy: 'plant' });
    expect(byPlant.rows.find((r) => r.id === String(plantA))?.eligibleDeviceCount).toBe(2);
    expect(byPlant.rows.find((r) => r.id === String(plantB))?.uptimePct).toBe(50);

    const byCompany = await service.fleetUptime(ohScope, { month: '2026-05', groupBy: 'company' });
    expect(byCompany.rows.find((r) => r.id === String(companyId))?.eligibleDeviceCount).toBe(3);
  });

  it('a ZM is scoped to their own zone only', async () => {
    const report = await service.fleetUptime({ role: 'ZONAL_MANAGER', zoneId: Number(zoneA) }, { month: '2026-05', groupBy: 'zone' });
    expect(report.rows.map((r) => r.id)).toEqual([String(zoneA)]);
    expect(report.fleet.eligibleDeviceCount).toBe(2);
  });
});
