import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Result of one month's aggregation run. */
export interface FleetUptimeAggregationResult {
  month: string; // ISO date of the month's first day
  devices: number;
}

interface DeviceRow {
  deviceId: bigint;
  eligible: boolean;
  plantId: bigint | null;
  companyId: bigint | null;
  zoneId: bigint | null;
}
interface CycleRow {
  cycleId: string;
  deviceId: bigint;
  openedAt: Date;
  closedAt: Date | null;
  repeatFailure: boolean;
}
interface ClosureRow {
  deviceId: bigint;
  status: string;
  count: number;
}

/**
 * Fleet Uptime aggregation worker (Issue 39, CONTEXT §Fleet Uptime). `computeMonth` pre-computes one
 * `device_downtime_summary_monthly` row per device so the report never scans raw telemetry. A device's
 * downtime in the month is its **failure-cycle overlap** with the month window (clamped to the month;
 * an open cycle runs to the window end = `min(now, month end)` so an incomplete current month isn't
 * penalised for the future). `eligible` snapshots `device_states.eligible_for_uptime` (active PGI ≤15d
 * AND not Non-Op). Auto-recovery (`CLOSED_AUTO_RECOVERY`) and SE-repaired (`CLOSED`) closures are counted
 * separately so SE productivity is not inflated. On-demand (no scheduler) — a BullMQ month-end cron
 * wires to it when scheduling lands, same posture as `VerificationService`. Idempotent (per-device upsert).
 */
@Injectable()
export class FleetUptimeAggregationService {
  constructor(private readonly prisma: PrismaService) {}

  async computeMonth(month: Date, now: Date = new Date()): Promise<FleetUptimeAggregationResult> {
    const monthStart = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1));
    const monthEnd = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1));
    const windowEnd = now.getTime() < monthEnd.getTime() ? now : monthEnd;
    const windowSeconds = Math.max(0, Math.floor((windowEnd.getTime() - monthStart.getTime()) / 1000));

    const devices = await this.prisma.$queryRaw<DeviceRow[]>(Prisma.sql`
      SELECT ds.device_id AS "deviceId", ds.eligible_for_uptime AS "eligible",
             ds.plant_id AS "plantId", ds.company_id AS "companyId", z.zone_id AS "zoneId"
      FROM device_states ds
      LEFT JOIN plants p ON p.plant_id = ds.plant_id
      LEFT JOIN zones z ON z.zone_id = p.zone_id`);

    const cycles = await this.prisma.$queryRaw<CycleRow[]>(Prisma.sql`
      SELECT cycle_id AS "cycleId", device_id AS "deviceId", opened_at AS "openedAt", closed_at AS "closedAt",
             repeat_failure AS "repeatFailure"
      FROM failure_cycles
      WHERE opened_at < ${windowEnd} AND (closed_at IS NULL OR closed_at > ${monthStart})`);

    // Cycle ids (opened this month) that incurred a Component Request — drives component-related downtime.
    const componentCycles = await this.prisma.$queryRaw<{ cycleId: string }[]>(Prisma.sql`
      SELECT DISTINCT cr.failure_cycle_id AS "cycleId"
      FROM component_request cr
      JOIN failure_cycles fc ON fc.cycle_id = cr.failure_cycle_id
      WHERE fc.opened_at >= ${monthStart} AND fc.opened_at < ${monthEnd}`);
    const componentCycleIds = new Set(componentCycles.map((c) => c.cycleId));

    const closures = await this.prisma.$queryRaw<ClosureRow[]>(Prisma.sql`
      SELECT device_id AS "deviceId", status::text AS "status", COUNT(*)::int AS "count"
      FROM tickets
      WHERE work_type = 'TROUBLESHOOT' AND status IN ('CLOSED', 'CLOSED_AUTO_RECOVERY')
        AND closed_at >= ${monthStart} AND closed_at < ${monthEnd}
      GROUP BY device_id, status`);

    const cyclesByDevice = groupBy(cycles, (c) => c.deviceId);
    const closuresByDevice = groupBy(closures, (c) => c.deviceId);

    for (const d of devices) {
      const deviceCycles = cyclesByDevice.get(d.deviceId) ?? [];
      const downtimeSeconds = deviceCycles.reduce(
        (sum, c) => sum + overlapSeconds(c.openedAt, c.closedAt ?? windowEnd, monthStart, windowEnd),
        0,
      );
      const cls = closuresByDevice.get(d.deviceId) ?? [];
      const autoRecoveryClosures = cls.find((c) => c.status === 'CLOSED_AUTO_RECOVERY')?.count ?? 0;
      const seRepairedClosures = cls.find((c) => c.status === 'CLOSED')?.count ?? 0;

      // Cycle-level metrics, attributed to the month the cycle opened in (an open cycle's episode runs
      // to the window end). `recover*` covers closed cycles only (average time-to-recover numerator).
      const openedThisMonth = deviceCycles.filter((c) => c.openedAt >= monthStart && c.openedAt < monthEnd);
      const episode = (c: CycleRow) => Math.max(0, Math.floor(((c.closedAt ?? windowEnd).getTime() - c.openedAt.getTime()) / 1000));
      const closedThisMonth = openedThisMonth.filter((c) => c.closedAt !== null);

      const data = {
        zoneId: d.zoneId,
        companyId: d.companyId,
        plantId: d.plantId,
        eligible: d.eligible,
        windowSeconds: BigInt(windowSeconds),
        downtimeSeconds: BigInt(Math.min(downtimeSeconds, windowSeconds)),
        autoRecoveryClosures,
        seRepairedClosures,
        cycleCount: openedThisMonth.length,
        repeatFailureCount: openedThisMonth.filter((c) => c.repeatFailure).length,
        longestEpisodeSeconds: BigInt(openedThisMonth.reduce((max, c) => Math.max(max, episode(c)), 0)),
        recoverSecondsSum: BigInt(closedThisMonth.reduce((sum, c) => sum + episode(c), 0)),
        recoveredCycles: closedThisMonth.length,
        componentDowntimeSeconds: BigInt(openedThisMonth.filter((c) => componentCycleIds.has(c.cycleId)).reduce((sum, c) => sum + episode(c), 0)),
        computedAt: now,
      };
      await this.prisma.deviceDowntimeSummaryMonthly.upsert({
        where: { deviceId_month: { deviceId: d.deviceId, month: monthStart } },
        create: { deviceId: d.deviceId, month: monthStart, ...data },
        update: data,
      });
    }

    return { month: monthStart.toISOString().slice(0, 10), devices: devices.length };
  }
}

/** Seconds of `[open, close]` that fall inside `[winStart, winEnd]` (clamped, never negative). */
function overlapSeconds(open: Date, close: Date, winStart: Date, winEnd: Date): number {
  const start = Math.max(open.getTime(), winStart.getTime());
  const end = Math.min(close.getTime(), winEnd.getTime());
  return Math.max(0, Math.floor((end - start) / 1000));
}

function groupBy<T>(rows: T[], key: (row: T) => bigint): Map<bigint, T[]> {
  const map = new Map<bigint, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = map.get(k);
    if (list) list.push(row);
    else map.set(k, [row]);
  }
  return map;
}
