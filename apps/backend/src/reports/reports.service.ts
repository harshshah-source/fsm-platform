import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type FleetUptimeGroupBy = 'zone' | 'company' | 'plant';

interface ReportScope {
  role: string;
  zoneId: number | null;
}

export interface FleetUptimeRow {
  id: string;
  name: string;
  eligibleDeviceCount: number;
  /** Time-weighted online % over this group's eligible devices, 0–100, 2 decimals. */
  uptimePct: number;
  autoRecoveryClosures: number;
  seRepairedClosures: number;
}

export interface FleetUptimeReport {
  month: string; // ISO date of the month's first day
  groupBy: FleetUptimeGroupBy;
  fleet: {
    eligibleDeviceCount: number;
    uptimePct: number;
    autoRecoveryClosures: number;
    seRepairedClosures: number;
  };
  rows: FleetUptimeRow[];
}

type RawGroupRow = {
  id: string;
  name: string;
  deviceCount: number;
  downtime: bigint;
  window: bigint;
  autoRecovery: number;
  seRepaired: number;
};

export interface SoftInactivePoint {
  capturedAt: string;
  period: string;
  softInactiveCount: number;
  eligibleDeviceCount: number;
  deficitMode: boolean;
}
export interface SoftInactiveZoneSeries {
  zoneId: string;
  zoneName: string;
  points: SoftInactivePoint[];
}
export interface SoftInactiveTrend {
  sinceDays: number;
  zones: SoftInactiveZoneSeries[];
}

type RawTrendRow = {
  zoneId: string;
  zoneName: string;
  capturedAt: Date;
  period: string;
  softInactiveCount: number;
  eligibleDeviceCount: number;
  deficitMode: boolean;
};

/**
 * Reports read surface (Issue 39). `fleetUptime` serves the Fleet Uptime % report purely from
 * `device_downtime_summary_monthly` (the aggregation worker's output) — never raw telemetry or
 * multi-year scans (CONTEXT §Fleet Uptime). Uptime% is time-weighted `(1 − Σdowntime/Σwindow)` over the
 * **Eligible Devices** denominator (`eligible = true` rows only); broken down per zone / company / plant.
 * A ZONAL_MANAGER is scoped to their own zone; CSM / Operations Head see all zones. Auto-recovery
 * (`CLOSED_AUTO_RECOVERY`) and SE-repaired (`CLOSED`) closures are surfaced separately so SE
 * productivity is not inflated.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async fleetUptime(scope: ReportScope, opts: { month: string; groupBy: FleetUptimeGroupBy }): Promise<FleetUptimeReport> {
    const monthStart = parseMonth(opts.month);
    const restrictZone = scope.role === 'ZONAL_MANAGER' ? scope.zoneId : null;
    const zoneFilter = restrictZone !== null ? Prisma.sql`AND s.zone_id = ${BigInt(restrictZone)}` : Prisma.empty;

    const rows = await this.queryGroups(opts.groupBy, monthStart, zoneFilter);

    let downtime = 0;
    let window = 0;
    const fleet = { eligibleDeviceCount: 0, autoRecoveryClosures: 0, seRepairedClosures: 0 };
    const out: FleetUptimeRow[] = rows.map((r) => {
      downtime += Number(r.downtime);
      window += Number(r.window);
      fleet.eligibleDeviceCount += r.deviceCount;
      fleet.autoRecoveryClosures += r.autoRecovery;
      fleet.seRepairedClosures += r.seRepaired;
      return {
        id: r.id,
        name: r.name,
        eligibleDeviceCount: r.deviceCount,
        uptimePct: uptimePct(Number(r.downtime), Number(r.window)),
        autoRecoveryClosures: r.autoRecovery,
        seRepairedClosures: r.seRepaired,
      };
    });

    return {
      month: monthStart.toISOString().slice(0, 10),
      groupBy: opts.groupBy,
      fleet: { ...fleet, uptimePct: uptimePct(downtime, window) },
      rows: out,
    };
  }

  /**
   * Soft Inactive Count trend (Issue 40 AC#3): the per-zone twice-daily series for the last `days`
   * (default 7, max 90), read purely from `soft_inactive_count_history`. Operations-Head view.
   */
  async softInactiveTrend(opts: { days?: number } = {}, now: Date = new Date()): Promise<SoftInactiveTrend> {
    const days = Math.min(Math.max(Math.trunc(opts.days ?? 7), 1), 90);
    const cutoff = new Date(now.getTime() - days * 86_400_000);
    const rows = await this.prisma.$queryRaw<RawTrendRow[]>(Prisma.sql`
      SELECT z.zone_id::text AS "zoneId", z.name AS "zoneName", h.captured_at AS "capturedAt",
             h.period AS "period", h.soft_inactive_count AS "softInactiveCount",
             h.eligible_device_count AS "eligibleDeviceCount", h.deficit_mode AS "deficitMode"
      FROM soft_inactive_count_history h
      JOIN zones z ON z.zone_id = h.zone_id
      WHERE h.captured_at >= ${cutoff}
      ORDER BY z.name, h.captured_at ASC`);

    const byZone = new Map<string, SoftInactiveZoneSeries>();
    for (const r of rows) {
      let series = byZone.get(r.zoneId);
      if (!series) {
        series = { zoneId: r.zoneId, zoneName: r.zoneName, points: [] };
        byZone.set(r.zoneId, series);
      }
      series.points.push({
        capturedAt: r.capturedAt.toISOString(),
        period: r.period,
        softInactiveCount: r.softInactiveCount,
        eligibleDeviceCount: r.eligibleDeviceCount,
        deficitMode: r.deficitMode,
      });
    }
    return { sinceDays: days, zones: [...byZone.values()] };
  }

  private queryGroups(groupBy: FleetUptimeGroupBy, monthStart: Date, zoneFilter: Prisma.Sql): Promise<RawGroupRow[]> {
    const select = Prisma.sql`
      COUNT(*)::int AS "deviceCount",
      COALESCE(SUM(s.downtime_seconds), 0)::bigint AS "downtime",
      COALESCE(SUM(s.window_seconds), 0)::bigint AS "window",
      COALESCE(SUM(s.auto_recovery_closures), 0)::int AS "autoRecovery",
      COALESCE(SUM(s.se_repaired_closures), 0)::int AS "seRepaired"`;
    const where = Prisma.sql`WHERE s.month = ${monthStart} AND s.eligible = true ${zoneFilter}`;

    if (groupBy === 'company') {
      return this.prisma.$queryRaw<RawGroupRow[]>(Prisma.sql`
        SELECT c.company_id::text AS "id", c.name AS "name", ${select}
        FROM device_downtime_summary_monthly s
        JOIN company_master c ON c.company_id = s.company_id
        ${where}
        GROUP BY c.company_id, c.name
        ORDER BY c.name`);
    }
    if (groupBy === 'plant') {
      return this.prisma.$queryRaw<RawGroupRow[]>(Prisma.sql`
        SELECT p.plant_id::text AS "id", p.name AS "name", ${select}
        FROM device_downtime_summary_monthly s
        JOIN plants p ON p.plant_id = s.plant_id
        ${where}
        GROUP BY p.plant_id, p.name
        ORDER BY p.name`);
    }
    return this.prisma.$queryRaw<RawGroupRow[]>(Prisma.sql`
      SELECT z.zone_id::text AS "id", z.name AS "name", ${select}
      FROM device_downtime_summary_monthly s
      JOIN zones z ON z.zone_id = s.zone_id
      ${where}
      GROUP BY z.zone_id, z.name
      ORDER BY z.name`);
  }
}

/** `(1 − downtime/window) × 100`, 2 decimals. A zero window (no eligible time) reports 100%. */
function uptimePct(downtime: number, window: number): number {
  if (window <= 0) return 100;
  return Math.round((1 - downtime / window) * 100 * 100) / 100;
}

/** Parse `YYYY-MM` to the UTC first-of-month Date. */
function parseMonth(month: string): Date {
  const m = /^(\d{4})-(\d{2})$/.exec(month ?? '');
  if (!m) throw new BadRequestException({ code: 'INVALID_MONTH', hint: 'expected YYYY-MM' });
  const year = Number(m[1]);
  const mon = Number(m[2]);
  if (mon < 1 || mon > 12) throw new BadRequestException({ code: 'INVALID_MONTH', hint: 'month 01–12' });
  return new Date(Date.UTC(year, mon - 1, 1));
}
