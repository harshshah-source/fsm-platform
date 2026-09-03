import { randomUUID } from 'node:crypto';
import { FleetUptimeAggregationService } from '../src/reports/fleet-uptime-aggregation.service';
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
/**
 * March 2026 — **a month no other spec writes**, and that is load-bearing rather than arbitrary.
 *
 * This suite asserts `fleet.eligibleDeviceCount` at **fleet scope, i.e. with no zone filter**, so it
 * counts every `device_downtime_summary_monthly` row for its month regardless of which spec created
 * it. It used May 2026 — the same month as `fleet-uptime-aggregation.e2e-spec.ts`, which calls
 * `computeMonth(MONTH)`, a **global delete+insert across all devices** for that month. When the two
 * interleave across vitest workers the aggregation inserts rows for its own devices into the month
 * this suite is counting, and `expect(...).toBe(3)` sees 5.
 *
 * Observed on 2026-08-10 (a full run failed here while both specs passed in isolation and paired).
 * Same class as #215: a spec whose correctness depends on what another spec left in shared state.
 * Isolating the month is the fix an unscoped assertion actually needs — a `deleteMany` in `afterAll`
 * cannot help, because the collision is *concurrent*, not leftover.
 */
const MONTH = new Date(Date.UTC(2026, 2, 1)); // March 2026
const MONTH_PARAM = '2026-03';
const W = 1000; // window seconds per device (round numbers for easy math)

/**
 * #346 — two months chosen because **nothing in the tree writes them**, for the same isolation reason
 * MONTH is March. They carry the two shapes of "no eligible device-time", which are not the same
 * shape and used to produce the same fabricated `100`:
 *
 *  - `EMPTY_MONTH` — not one summary row exists. The report has no groups at all.
 *  - `ZERO_WINDOW_MONTH` — rows exist and devices are eligible, but the month's window is zero
 *    seconds (what `computeMonth` writes for a month that has not started: `windowEnd = min(now,
 *    monthEnd)` clamped at `max(0, …)`). A device with a real row and no elapsed time is the case
 *    that reads most convincingly as a real 100%.
 */
const EMPTY_MONTH_PARAM = '2029-11';
const ZERO_WINDOW_MONTH = new Date(Date.UTC(2029, 11, 1)); // December 2029
const ZERO_WINDOW_MONTH_PARAM = '2029-12';

describe('Issue 39 slice 2 — ReportsService.fleetUptime', () => {
  let prisma: PrismaService;
  let service: ReportsService;

  let zoneA: bigint;
  let zoneB: bigint;
  let companyId: bigint;
  let plantA: bigint;
  let plantB: bigint;
  let devSeq = String(9_391_000n);
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

    // #346 — a month that has not started yet: an eligible device, a real row, a ZERO window. Kept in
    // its own month so it cannot move March's denominators.
    await summary(zoneA, plantA, true, 0, 0, 0, { month: ZERO_WINDOW_MONTH, windowSeconds: 0 });
  });

  async function summary(
    zoneId: bigint,
    plantId: bigint,
    eligible: boolean,
    downtime: number,
    auto: number,
    se: number,
    override: { month?: Date; windowSeconds?: number } = {},
  ): Promise<void> {
    const deviceId = String(devSeq++);
    devices.push(deviceId);
    await prisma.device.create({ data: { deviceId, deviceType: 'GPS-X' } });
    await prisma.deviceDowntimeSummaryMonthly.create({
      data: {
        deviceId, month: override.month ?? MONTH, zoneId, companyId, plantId, eligible,
        windowSeconds: BigInt(override.windowSeconds ?? W), downtimeSeconds: BigInt(downtime),
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
    const report = await service.fleetUptime(ohScope, { month: MONTH_PARAM, groupBy: 'zone' });
    expect(report.month).toBe('2026-03-01');
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
    const report = await service.fleetUptime(ohScope, { month: MONTH_PARAM, groupBy: 'zone' });
    // 3 eligible devices, Σwindow=3000, Σdowntime=600 → (1 - 600/3000)*100 = 80.0
    expect(report.fleet.eligibleDeviceCount).toBe(3);
    expect(report.fleet.uptimePct).toBe(80);
    expect(report.fleet.autoRecoveryClosures).toBe(1);
    expect(report.fleet.seRepairedClosures).toBe(3);
  });

  it('groups by plant and by company', async () => {
    const byPlant = await service.fleetUptime(ohScope, { month: MONTH_PARAM, groupBy: 'plant' });
    expect(byPlant.rows.find((r) => r.id === String(plantA))?.eligibleDeviceCount).toBe(2);
    expect(byPlant.rows.find((r) => r.id === String(plantB))?.uptimePct).toBe(50);

    const byCompany = await service.fleetUptime(ohScope, { month: MONTH_PARAM, groupBy: 'company' });
    expect(byCompany.rows.find((r) => r.id === String(companyId))?.eligibleDeviceCount).toBe(3);
  });

  /**
   * #346 AC1 — **the honesty case.** `(1 − downtime/window)` is undefined when the window is zero, and
   * the old helper answered `100` — the best possible number, indistinguishable from a perfect fleet.
   * The default Reports view asked for the *current* month while the cron only ever wrote the previous
   * one, so this was not an edge case: it was the first number the page showed.
   */
  describe('#346 — a window of zero is no data, not 100%', () => {
    it('a month with no summary rows at all: null uptime, zero eligible devices, no groups', async () => {
      const report = await service.fleetUptime(ohScope, { month: EMPTY_MONTH_PARAM, groupBy: 'zone' });
      expect(report.fleet.uptimePct).toBeNull();
      expect(report.fleet.eligibleDeviceCount).toBe(0);
      expect(report.rows).toEqual([]);
    });

    it('a month with eligible rows but a zero window: the ROW is null too, not 100', async () => {
      const report = await service.fleetUptime(ohScope, { month: ZERO_WINDOW_MONTH_PARAM, groupBy: 'zone' });
      const a = report.rows.find((r) => r.id === String(zoneA));
      // The row is present — the devices are real and counted — and its uptime is unknown.
      expect(a?.eligibleDeviceCount).toBe(1);
      expect(a?.uptimePct).toBeNull();
      expect(report.fleet.uptimePct).toBeNull();
      expect(report.fleet.eligibleDeviceCount).toBe(1);
    });

    it('never reports 100 for a zero window at any grouping', async () => {
      for (const groupBy of ['zone', 'company', 'plant'] as const) {
        const report = await service.fleetUptime(ohScope, { month: ZERO_WINDOW_MONTH_PARAM, groupBy });
        expect(report.fleet.uptimePct).not.toBe(100);
        expect(report.rows.map((r) => r.uptimePct)).not.toContain(100);
      }
    });
  });

  it('a ZM is scoped to their own zone only', async () => {
    const report = await service.fleetUptime({ role: 'ZONAL_MANAGER', zoneId: Number(zoneA) }, { month: MONTH_PARAM, groupBy: 'zone' });
    expect(report.rows.map((r) => r.id)).toEqual([String(zoneA)]);
    expect(report.fleet.eligibleDeviceCount).toBe(2);
  });

  /**
   * **Audit finding F7** (#365) — `se_repaired_closures` counted every `CLOSED` TROUBLESHOOT ticket,
   * and three different writers put a ticket into `CLOSED`: the verification service (a real repair,
   * `closure_type IS NULL`), `DeviceDepartureService` (`DEVICE_UNDEPLOYED_CLOSE` — the vehicle left the
   * fleet) and `PlantDeactivationService` (`OPERATIONS_HEAD_OVERRIDE_CLOSE`). So an engineer whose
   * plants happened to lose vehicles read as *more productive* than one who repaired devices, in the
   * column whose name says the opposite — and that column is the input to the SE productivity report,
   * i.e. to staffing decisions.
   *
   * This runs the aggregation rather than seeding the cube (the rest of the suite seeds), because the
   * defect is in the attribution, not the read. Its own month and its own devices: the worker is a
   * global delete+insert per month, so it must not touch March's rows (see {@link MONTH}).
   */
  describe('F7 — se_repaired_closures counts repairs only, never departures', () => {
    const F7_MONTH = new Date(Date.UTC(2027, 7, 1)); // August 2027 — no other spec writes it
    const F7_MONTH_PARAM = '2027-08';
    const F7_NOW = new Date(Date.UTC(2027, 8, 15, 12, 0, 0)); // September 2027 — August is complete
    const f7Cycles: string[] = [];
    const f7Tickets: string[] = [];
    let f7Device: string;

    /** A closed TROUBLESHOOT ticket of a given kind. Zero-length cycle so it adds no downtime. */
    const closedTicket = async (
      status: 'CLOSED' | 'CLOSED_AUTO_RECOVERY',
      closureType: 'DEVICE_UNDEPLOYED_CLOSE' | 'OPERATIONS_HEAD_OVERRIDE_CLOSE' | 'AUTO_RECOVERY_CLOSE' | null,
      closedAt: Date,
    ): Promise<void> => {
      const cycleId = randomUUID();
      f7Cycles.push(cycleId);
      await prisma.failureCycle.create({ data: { cycleId, deviceId: f7Device, state: 'VERIFIED', openedAt: closedAt, closedAt } });
      const t = await prisma.ticket.create({
        data: {
          workType: 'TROUBLESHOOT', status, closureType, deviceId: f7Device, failureCycleId: cycleId,
          plantId: plantA, companyId, companyTier: 'GOLD', closedAt, lastStateChangedAt: closedAt,
        },
      });
      f7Tickets.push(t.ticketId);
    };

    beforeAll(async () => {
      f7Device = '9391900';
      await prisma.device.create({ data: { deviceId: f7Device, deviceType: 'GPS-X' } });
      await prisma.deviceState.create({
        data: { deviceId: f7Device, eligibleForUptime: true, latestGpsDatetime: F7_NOW, plantId: plantA, companyId, computedAt: F7_NOW },
      });

      // Two genuine repairs — the verification service leaves `closure_type` NULL.
      await closedTicket('CLOSED', null, new Date(Date.UTC(2027, 7, 3)));
      await closedTicket('CLOSED', null, new Date(Date.UTC(2027, 7, 4)));
      // Three departures. Before F7 these read as three more repairs by whoever held the plants.
      await closedTicket('CLOSED', 'DEVICE_UNDEPLOYED_CLOSE', new Date(Date.UTC(2027, 7, 5)));
      await closedTicket('CLOSED', 'DEVICE_UNDEPLOYED_CLOSE', new Date(Date.UTC(2027, 7, 6)));
      await closedTicket('CLOSED', 'DEVICE_UNDEPLOYED_CLOSE', new Date(Date.UTC(2027, 7, 7)));
      // A plant deactivation — also nobody's repair, and not a departure either.
      await closedTicket('CLOSED', 'OPERATIONS_HEAD_OVERRIDE_CLOSE', new Date(Date.UTC(2027, 7, 8)));
      // The self-healed closure, which has been counted separately since Issue 39.
      await closedTicket('CLOSED_AUTO_RECOVERY', 'AUTO_RECOVERY_CLOSE', new Date(Date.UTC(2027, 7, 9)));

      await new FleetUptimeAggregationService(prisma).computeMonth(F7_MONTH, F7_NOW);
    });

    afterAll(async () => {
      await prisma.deviceDowntimeSummaryMonthly.deleteMany({ where: { month: F7_MONTH } });
      await prisma.ticket.deleteMany({ where: { ticketId: { in: f7Tickets } } });
      await prisma.failureCycle.deleteMany({ where: { cycleId: { in: f7Cycles } } });
      await prisma.deviceState.deleteMany({ where: { deviceId: f7Device } });
      await prisma.device.deleteMany({ where: { deviceId: f7Device } });
    });

    it('the summary row counts the two repairs, not the seven closures', async () => {
      const s = await prisma.deviceDowntimeSummaryMonthly.findUniqueOrThrow({
        where: { deviceId_month: { deviceId: f7Device, month: F7_MONTH } },
      });
      expect(s.seRepairedClosures).toBe(2);
      expect(s.autoRecoveryClosures).toBe(1);
    });

    it('the report the dashboard reads carries the split, not the inflated figure', async () => {
      const report = await service.fleetUptime(ohScope, { month: F7_MONTH_PARAM, groupBy: 'plant' });
      const row = report.rows.find((r) => r.id === String(plantA));
      expect(row?.seRepairedClosures).toBe(2);
      expect(row?.autoRecoveryClosures).toBe(1);
    });
  });
});
