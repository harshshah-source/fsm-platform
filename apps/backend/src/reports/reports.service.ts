import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, type RootCauseCategory } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** The documented root-cause taxonomy, canonical (schema) order — the report zero-fills the full set. */
export const ROOT_CAUSE_CATEGORIES: RootCauseCategory[] = [
  'POWER_ISSUE',
  'SIM_NETWORK_ISSUE',
  'GPS_ANTENNA_ISSUE',
  'DEVICE_HARDWARE_FAULT',
  'WIRING_ISSUE',
  'CONFIGURATION_ISSUE',
  'VEHICLE_ACCESS_ISSUE',
  'INSTALLATION_ISSUE',
  'CUSTOMER_SIDE_ISSUE',
  'UNKNOWN',
];

export interface RootCauseSlice {
  category: RootCauseCategory;
  count: number;
  /** Share of total submissions in the filtered window, 0–100, 2 decimals. */
  pct: number;
}

export interface RootCauseFilters {
  fromMonth?: string; // YYYY-MM (inclusive); defaults to current month
  toMonth?: string; // YYYY-MM (inclusive); defaults to fromMonth
  zoneId?: number | null;
  companyId?: number | null;
  plantId?: number | null;
  deviceType?: string | null;
  seId?: string | null;
}

export interface RootCauseReport {
  fromMonth: string; // ISO date of the range's first month
  toMonth: string; // ISO date of the range's last month
  totalSubmissions: number;
  filters: { zoneId: number | null; companyId: number | null; plantId: number | null; deviceType: string | null; seId: string | null };
  distribution: RootCauseSlice[];
}

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

  /**
   * Root Cause Analytics (Issue 41 AC#1–#4): the % distribution of structured device-inactivity root
   * causes over `root_cause_summary_monthly` — never raw scans, never free-text. Every documented category
   * is represented (zero-filled, canonical order). Filterable by Zone / Company / Plant / device type / SE
   * / month range. A ZONAL_MANAGER is pinned to their own zone (their `zoneId` overrides any zone filter);
   * CSM / Operations Head see all zones and may filter by one.
   */
  async rootCause(scope: ReportScope, opts: RootCauseFilters = {}, now: Date = new Date()): Promise<RootCauseReport> {
    const fromStart = parseMonth(opts.fromMonth ?? defaultMonth(now));
    const toStart = parseMonth(opts.toMonth ?? opts.fromMonth ?? defaultMonth(now));
    if (toStart.getTime() < fromStart.getTime()) {
      throw new BadRequestException({ code: 'INVALID_RANGE', hint: 'fromMonth must be ≤ toMonth' });
    }

    const restrictZone = scope.role === 'ZONAL_MANAGER' ? scope.zoneId : (opts.zoneId ?? null);
    const filters = [
      restrictZone !== null && restrictZone !== undefined ? Prisma.sql`AND zone_id = ${BigInt(restrictZone)}` : Prisma.empty,
      opts.companyId != null ? Prisma.sql`AND company_id = ${BigInt(opts.companyId)}` : Prisma.empty,
      opts.plantId != null ? Prisma.sql`AND plant_id = ${BigInt(opts.plantId)}` : Prisma.empty,
      opts.deviceType != null ? Prisma.sql`AND device_type = ${opts.deviceType}` : Prisma.empty,
      opts.seId != null ? Prisma.sql`AND se_id = ${opts.seId}::uuid` : Prisma.empty,
    ];

    const rows = await this.prisma.$queryRaw<{ category: string; count: bigint }[]>(Prisma.sql`
      SELECT root_cause_category::text AS category, COALESCE(SUM(submission_count), 0)::bigint AS count
      FROM root_cause_summary_monthly
      WHERE month >= ${fromStart} AND month <= ${toStart} ${Prisma.join(filters, ' ')}
      GROUP BY root_cause_category`);

    const counts = new Map(rows.map((r) => [r.category, Number(r.count)]));
    const total = [...counts.values()].reduce((s, c) => s + c, 0);
    const distribution = ROOT_CAUSE_CATEGORIES.map((category) => {
      const count = counts.get(category) ?? 0;
      return { category, count, pct: total > 0 ? Math.round((count / total) * 100 * 100) / 100 : 0 };
    });

    return {
      fromMonth: fromStart.toISOString().slice(0, 10),
      toMonth: toStart.toISOString().slice(0, 10),
      totalSubmissions: total,
      filters: {
        zoneId: restrictZone ?? null,
        companyId: opts.companyId ?? null,
        plantId: opts.plantId ?? null,
        deviceType: opts.deviceType ?? null,
        seId: opts.seId ?? null,
      },
      distribution,
    };
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

/** Current month as `YYYY-MM` (UTC). */
function defaultMonth(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
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
