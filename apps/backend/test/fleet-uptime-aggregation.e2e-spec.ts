import { randomUUID } from 'node:crypto';
import { FleetUptimeAggregationService } from '../src/reports/fleet-uptime-aggregation.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 39 slice 1 — the Fleet Uptime aggregation worker. `computeMonth(month, now)` writes one
 * `device_downtime_summary_monthly` row per device: `downtime_seconds` = the device's failure-cycle
 * overlap with the month window (clamped to month boundaries; an open cycle runs to the window end),
 * `eligible` mirrors `device_states.eligible_for_uptime`, and auto-recovery vs SE-repaired closures are
 * counted separately. A completed month (May 2026, `now` in June) → the window is the full month.
 */
const NS = Date.now();
const MONTH = new Date(Date.UTC(2026, 4, 1)); // May 2026 (month index 4)
const NOW = new Date(Date.UTC(2026, 5, 26, 12, 0, 0)); // 26 Jun 2026 — May is complete
const MAY_SECONDS = 31 * 86_400; // 2,678,400

describe('Issue 39 slice 1 — FleetUptimeAggregationService.computeMonth', () => {
  let prisma: PrismaService;
  let service: FleetUptimeAggregationService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let devSeq = 9_390_000n;
  const devices: bigint[] = [];
  const cycleIds: string[] = [];
  const ticketIds: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new FleetUptimeAggregationService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-fu-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-fu-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-fu-' + NS, zoneId } })).plantId;
  });

  afterAll(async () => {
    await prisma.deviceDowntimeSummaryMonthly.deleteMany({ where: { deviceId: { in: devices } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { cycleId: { in: cycleIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: devices } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: devices } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  /** A device with a device_states row (eligible toggle). */
  const makeDevice = async (eligible: boolean): Promise<bigint> => {
    const deviceId = devSeq++;
    devices.push(deviceId);
    await prisma.device.create({ data: { deviceId, deviceType: 'GPS-X' } });
    await prisma.deviceState.create({
      data: { deviceId, eligibleForUptime: eligible, plantId, companyId, computedAt: NOW },
    });
    return deviceId;
  };

  const addCycle = async (deviceId: bigint, openedAt: Date, closedAt: Date | null): Promise<void> => {
    const cycleId = randomUUID();
    cycleIds.push(cycleId);
    await prisma.failureCycle.create({ data: { cycleId, deviceId, state: closedAt ? 'VERIFIED' : 'OPEN', openedAt, closedAt } });
  };

  const addClosedTicket = async (deviceId: bigint, status: 'CLOSED' | 'CLOSED_AUTO_RECOVERY', closedAt: Date): Promise<void> => {
    // A TROUBLESHOOT ticket requires a parent failure cycle (check constraint). Zero-length cycle
    // (openedAt == closedAt) so it adds no downtime — this case only exercises closure counting.
    const cycleId = randomUUID();
    cycleIds.push(cycleId);
    await prisma.failureCycle.create({ data: { cycleId, deviceId, state: 'VERIFIED', openedAt: closedAt, closedAt } });
    const t = await prisma.ticket.create({
      data: { workType: 'TROUBLESHOOT', status, deviceId, failureCycleId: cycleId, plantId, companyId, companyTier: 'GOLD', closedAt, lastStateChangedAt: closedAt },
    });
    ticketIds.push(t.ticketId);
  };

  const summaryFor = (deviceId: bigint) =>
    prisma.deviceDowntimeSummaryMonthly.findUniqueOrThrow({ where: { deviceId_month: { deviceId, month: MONTH } } });

  it('a device with no failure cycles → zero downtime, full-month window, eligible mirrored', async () => {
    const up = await makeDevice(true);
    const ineligible = await makeDevice(false);
    await service.computeMonth(MONTH, NOW);

    const s = await summaryFor(up);
    expect(Number(s.windowSeconds)).toBe(MAY_SECONDS);
    expect(Number(s.downtimeSeconds)).toBe(0);
    expect(s.eligible).toBe(true);
    expect(s.zoneId).toBe(zoneId);
    expect(s.plantId).toBe(plantId);

    expect((await summaryFor(ineligible)).eligible).toBe(false);
  });

  it('a failure cycle fully inside the month contributes its exact duration as downtime', async () => {
    const d = await makeDevice(true);
    // 2-day outage: 10 May 00:00 → 12 May 00:00
    await addCycle(d, new Date(Date.UTC(2026, 4, 10)), new Date(Date.UTC(2026, 4, 12)));
    await service.computeMonth(MONTH, NOW);
    expect(Number((await summaryFor(d)).downtimeSeconds)).toBe(2 * 86_400);
  });

  it('a cycle straddling the month start is clamped to the month boundary', async () => {
    const d = await makeDevice(true);
    // opened 28 Apr, closed 2 May 00:00 → only 1 day (1–2 May) falls inside May
    await addCycle(d, new Date(Date.UTC(2026, 3, 28)), new Date(Date.UTC(2026, 4, 2)));
    await service.computeMonth(MONTH, NOW);
    expect(Number((await summaryFor(d)).downtimeSeconds)).toBe(1 * 86_400);
  });

  it('an open cycle (no closedAt) runs to the window end (full completed month here)', async () => {
    const d = await makeDevice(true);
    // opened 30 May 00:00, never closed → 31 May + nothing past month end (window end = 1 Jun) = 2 days
    await addCycle(d, new Date(Date.UTC(2026, 4, 30)), null);
    await service.computeMonth(MONTH, NOW);
    expect(Number((await summaryFor(d)).downtimeSeconds)).toBe(2 * 86_400);
  });

  it('separates auto-recovery closures from SE-repaired closures', async () => {
    const d = await makeDevice(true);
    await addClosedTicket(d, 'CLOSED_AUTO_RECOVERY', new Date(Date.UTC(2026, 4, 5)));
    await addClosedTicket(d, 'CLOSED_AUTO_RECOVERY', new Date(Date.UTC(2026, 4, 6)));
    await addClosedTicket(d, 'CLOSED', new Date(Date.UTC(2026, 4, 7)));
    // a closure in a different month must not count
    await addClosedTicket(d, 'CLOSED', new Date(Date.UTC(2026, 3, 7)));
    await service.computeMonth(MONTH, NOW);
    const s = await summaryFor(d);
    expect(s.autoRecoveryClosures).toBe(2);
    expect(s.seRepairedClosures).toBe(1);
  });

  it('is idempotent — recomputing the month overwrites, not duplicates', async () => {
    const d = await makeDevice(true);
    await addCycle(d, new Date(Date.UTC(2026, 4, 1)), new Date(Date.UTC(2026, 4, 4)));
    await service.computeMonth(MONTH, NOW);
    await service.computeMonth(MONTH, NOW);
    expect(Number((await summaryFor(d)).downtimeSeconds)).toBe(3 * 86_400);
    const count = await prisma.deviceDowntimeSummaryMonthly.count({ where: { deviceId: d, month: MONTH } });
    expect(count).toBe(1);
  });
});
