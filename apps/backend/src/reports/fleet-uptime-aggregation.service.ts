import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Result of one month's aggregation run. */
export interface FleetUptimeAggregationResult {
  month: string; // ISO date of the month's first day
  devices: number;
}

interface DeviceRow {
  deviceId: string;
  eligible: boolean;
  plantId: bigint | null;
  companyId: bigint | null;
  zoneId: bigint | null;
}
interface CycleRow {
  cycleId: string;
  deviceId: string;
  openedAt: Date;
  closedAt: Date | null;
  repeatFailure: boolean;
}
interface ClosureRow {
  deviceId: string;
  kind: ClosureKind;
  count: number;
}

/**
 * How a TROUBLESHOOT ticket's closure was *earned* — audit finding **F7**.
 *
 * `status` alone cannot answer this. Three different writers put a TROUBLESHOOT ticket into `CLOSED`
 * and only one of them is an engineer repairing a device:
 *
 *  - `SE_REPAIR` — `closure_type IS NULL`. `VerificationService.finalize` is the only path that closes
 *    a troubleshoot ticket without classifying the closure, because there is nothing to classify: the
 *    SE submitted a form, the device came back, the cycle verified. This is the **only** closure that
 *    is SE productivity.
 *  - `DEPARTURE` — `DEVICE_UNDEPLOYED_CLOSE` (`DeviceDepartureService`). The vehicle left the fleet
 *    and the master sync closed the ticket; no human went anywhere.
 *  - `ADMINISTRATIVE` — everything else, today `OPERATIONS_HEAD_OVERRIDE_CLOSE` from a plant
 *    deactivation. Also not repair work. Named rather than folded into `DEPARTURE` so a future closure
 *    type joins a bucket that is honestly "not attributed" instead of silently reading as a departure.
 *  - `AUTO_RECOVERY` — `status = 'CLOSED_AUTO_RECOVERY'`; already counted separately since Issue 39.
 *
 * **The defect this closes.** `se_repaired_closures` counted every `CLOSED` row, so an engineer whose
 * plants happened to have vehicles leave the fleet read as more productive than one who actually
 * repaired devices — and the column's name asserted the opposite. It is the input to the SE
 * productivity report (#365), i.e. to staffing decisions, which is what makes a quiet over-count worse
 * than a missing number. The counting is a `CASE` here rather than a `WHERE` at the read so the other
 * kinds stay countable: the split is structural, and a later column can surface `DEPARTURE` without
 * re-deriving it.
 */
type ClosureKind = 'SE_REPAIR' | 'DEPARTURE' | 'ADMINISTRATIVE' | 'AUTO_RECOVERY';

/**
 * Fleet Uptime aggregation worker (Issue 39, CONTEXT §Fleet Uptime). `computeMonth` pre-computes one
 * `device_downtime_summary_monthly` row per device so the report never scans raw telemetry. A device's
 * downtime in the month is its **failure-cycle overlap** with the month window (clamped to the month;
 * an open cycle runs to the window end = `min(now, month end)` so an incomplete current month isn't
 * penalised for the future). `eligible` snapshots `device_states.eligible_for_uptime` (active PGI ≤15d
 * AND not Non-Op). Closures are counted by **{@link ClosureKind}, not by status** (#365 / audit F7):
 * `se_repaired_closures` holds SE repairs alone, with departures and administrative closes excluded
 * rather than folded in — note this counts closures by `closed_at`, which is
 * why #229 had to fix `AutoRecoveryService` writing NULL there. **Scheduled** by the
 * `business-fleet-uptime` cron (`BusinessSweepSchedulerService`, gated by `BUSINESS_SWEEPS_ENABLED`)
 * since #108, and still recomputable on demand. Idempotent (per-device upsert). Job names asserted in
 * `test/scheduler-wiring.e2e-spec.ts` (#229 §4).
 */
@Injectable()
export class FleetUptimeAggregationService {
  constructor(private readonly prisma: PrismaService) {}

  async computeMonth(month: Date, now: Date = new Date()): Promise<FleetUptimeAggregationResult> {
    const monthStart = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1));
    const monthEnd = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1));
    const windowEnd = now.getTime() < monthEnd.getTime() ? now : monthEnd;
    const windowSeconds = Math.max(0, Math.floor((windowEnd.getTime() - monthStart.getTime()) / 1000));

    // #223 P3 — a device that has NEVER reported is excluded from the uptime denominator, not scored
    // 0%. This was the worst of the six surfaces in `cross-analysis.md` §2.3 and both original reports
    // missed it: uptime is failure-cycle overlap, a failure cycle is opened from inactivity, and
    // inactivity requires a timestamp — so a device that never reported contributed a full month of
    // ZERO downtime and scored 100%. The single most broken device in the fleet was the healthiest.
    // For Vasavadatta (545 NDD devices) that is not a marginal distortion.
    //
    // **The exclusion is applied HERE and deliberately NOT by clearing `eligible_for_uptime`**, which
    // is what "exclude from Fleet Uptime" most obviously suggests. That flag is also the ticket-creation
    // gate (`ticket-creation.service.ts` requires `eligibleForUptime: true`), so clearing it would
    // silently cancel operator decision P1 — the 892 confirmed-NDD devices would never be ticketed,
    // which is the entire point of #223. Two decided requirements pull in opposite directions through
    // one shared flag; the uptime side is the one that can move without breaking the other.
    const devices = await this.prisma.$queryRaw<DeviceRow[]>(Prisma.sql`
      SELECT ds.device_id AS "deviceId",
             (ds.eligible_for_uptime AND ds.latest_gps_datetime IS NOT NULL) AS "eligible",
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

    // F7 — closures split by how they were EARNED, not by status. See {@link ClosureKind}.
    const closures = await this.prisma.$queryRaw<ClosureRow[]>(Prisma.sql`
      SELECT device_id AS "deviceId",
             CASE
               WHEN status = 'CLOSED_AUTO_RECOVERY' THEN 'AUTO_RECOVERY'
               WHEN closure_type IS NULL THEN 'SE_REPAIR'
               WHEN closure_type = 'DEVICE_UNDEPLOYED_CLOSE' THEN 'DEPARTURE'
               ELSE 'ADMINISTRATIVE'
             END AS "kind",
             COUNT(*)::int AS "count"
      FROM tickets
      WHERE work_type = 'TROUBLESHOOT' AND status IN ('CLOSED', 'CLOSED_AUTO_RECOVERY')
        AND closed_at >= ${monthStart} AND closed_at < ${monthEnd}
      GROUP BY 1, 2`);

    const cyclesByDevice = groupBy(cycles, (c) => c.deviceId);
    const closuresByDevice = groupBy(closures, (c) => c.deviceId);

    for (const d of devices) {
      const deviceCycles = cyclesByDevice.get(d.deviceId) ?? [];
      const downtimeSeconds = deviceCycles.reduce(
        (sum, c) => sum + overlapSeconds(c.openedAt, c.closedAt ?? windowEnd, monthStart, windowEnd),
        0,
      );
      const cls = closuresByDevice.get(d.deviceId) ?? [];
      const autoRecoveryClosures = cls.find((c) => c.kind === 'AUTO_RECOVERY')?.count ?? 0;
      // F7 — `SE_REPAIR` only. A departure or a plant deactivation is a closure nobody earned, and
      // adding it here is what made this column overstate the engineers with the unluckiest plants.
      const seRepairedClosures = cls.find((c) => c.kind === 'SE_REPAIR')?.count ?? 0;

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

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = map.get(k);
    if (list) list.push(row);
    else map.set(k, [row]);
  }
  return map;
}
