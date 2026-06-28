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

export interface SystemEfficiencyFilters {
  from?: string; // YYYY-MM-DD (inclusive); defaults to today
  to?: string; // YYYY-MM-DD (inclusive); defaults to from
  zoneId?: number | null;
  companyId?: number | null;
  plantId?: number | null;
  deviceType?: string | null;
  seId?: string | null;
}

/** The rendered efficiency metrics — additive counts plus derived rates (%) and average stage times (s). */
export interface EfficiencyMetrics {
  failureCyclesOpened: number;
  ticketsCreated: number;
  troubleshootTicketsCreated: number;
  autoAssignments: number;
  manualAssignments: number;
  overrides: number;
  autoAssignmentRatePct: number;
  manualAssignmentRatePct: number;
  overrideRatePct: number;
  cyclesResolved: number;
  verifiedCycles: number;
  failedVerifications: number;
  autoRecoveries: number;
  repeatFailures: number;
  firstTimeFixes: number;
  componentPauses: number;
  agedResolutions: number;
  autoEscalations: number;
  repeatFailureRatePct: number;
  firstTimeFixRatePct: number;
  failedVerificationRatePct: number;
  autoRecoveryRatePct: number;
  slaCompliancePct: number;
  totalDowntimeSeconds: number;
  avgDowntimeSeconds: number | null;
  avgDetectionToTicketSeconds: number | null;
  avgTicketToAssignmentSeconds: number | null;
  avgAssignmentToOnsiteSeconds: number | null;
  avgOnsiteToSubmissionSeconds: number | null;
  avgSubmissionToVerificationSeconds: number | null;
  avgWarehouseFulfilmentSeconds: number | null;
  avgRecoveryClosureSeconds: number | null;
}

export interface SystemEfficiencyReport {
  from: string; // ISO date of the range's first day
  to: string; // ISO date of the range's last day
  filters: { zoneId: number | null; companyId: number | null; plantId: number | null; deviceType: string | null; seId: string | null };
  fleet: EfficiencyMetrics;
  byZone: (EfficiencyMetrics & { zoneId: string | null; zoneName: string | null })[];
}

/** Raw summed cube row — count columns arrive as `number`, second-sum columns as `bigint`. */
interface RawEfficiencyRow {
  zoneId: string | null;
  zoneName: string | null;
  failureCyclesOpened: number;
  ticketsCreated: number;
  troubleshootTicketsCreated: number;
  autoAssignments: number;
  manualAssignments: number;
  overrides: number;
  cyclesResolved: number;
  verifiedCycles: number;
  failedVerifications: number;
  autoRecoveries: number;
  repeatFailures: number;
  firstTimeFixes: number;
  componentPauses: number;
  agedResolutions: number;
  slaCompliantResolutions: number;
  autoEscalations: number;
  downtimeSecondsSum: bigint;
  detectionToTicketSecondsSum: bigint;
  detectionToTicketCount: number;
  ticketToAssignmentSecondsSum: bigint;
  ticketToAssignmentCount: number;
  assignmentToOnsiteSecondsSum: bigint;
  assignmentToOnsiteCount: number;
  onsiteToSubmissionSecondsSum: bigint;
  onsiteToSubmissionCount: number;
  submissionToVerificationSecondsSum: bigint;
  submissionToVerificationCount: number;
  warehouseFulfilmentSecondsSum: bigint;
  warehouseFulfilmentCount: number;
  recoveryClosureSecondsSum: bigint;
  recoveryClosureCount: number;
}

export interface ZmScorecardRow {
  zmId: string;
  zmName: string;
  zoneId: number;
  zoneName: string;
  overrides: number;
  removals: number;
  deferrals: number;
  reorders: number;
  swaps: number;
  reassignments: number;
  splitBatches: number;
  overrideAfterOnsite: number;
  manualAssignments: number;
  autoAssigned: number;
  /** overrides ÷ zone auto-assignments over the range, 0–100, 2 decimals. */
  overrideRatePct: number;
  /** Zone Fleet-Uptime compliance over the range (time-weighted), 0–100, 2 decimals. */
  zoneSlaCompliancePct: number;
}
export interface ZmScorecardTrendPoint {
  month: string;
  overrides: number;
  overrideAfterOnsite: number;
  manualAssignments: number;
  overrideRatePct: number;
  zoneSlaCompliancePct: number;
}
export interface ZmScorecardSeries {
  zmId: string;
  zmName: string;
  points: ZmScorecardTrendPoint[];
}
export interface ZmScorecardReport {
  fromMonth: string;
  toMonth: string;
  zoneId: number | null;
  rows: ZmScorecardRow[];
  trend: ZmScorecardSeries[];
}

type RawZmRow = {
  zmId: string;
  zmName: string;
  zoneId: string;
  zoneName: string;
  month: Date;
  overridesTotal: number;
  removals: number;
  deferrals: number;
  reorders: number;
  swaps: number;
  reassignments: number;
  splitBatches: number;
  overrideAfterOnsite: number;
  manualAssignments: number;
  autoAssignedCount: number;
  downtime: bigint;
  window: bigint;
};

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

  /**
   * ZM Performance Scorecard (Issue 43): the ZM-wise comparison (metrics summed over the month range)
   * with override rate (overrides ÷ zone auto-assignments) and zone SLA compliance (time-weighted Fleet
   * Uptime over the range), plus the per-ZM monthly trend, read purely from
   * `zm_performance_summary_monthly`. Optional zone drill-down. Operations-Head only (gated at the
   * controller — this report is never shown to the ZM and ZMs never enter their own scores).
   */
  async zmScorecard(opts: { fromMonth?: string; toMonth?: string; zoneId?: number | null } = {}, now: Date = new Date()): Promise<ZmScorecardReport> {
    const fromStart = parseMonth(opts.fromMonth ?? defaultMonth(now));
    const toStart = parseMonth(opts.toMonth ?? opts.fromMonth ?? defaultMonth(now));
    if (toStart.getTime() < fromStart.getTime()) {
      throw new BadRequestException({ code: 'INVALID_RANGE', hint: 'fromMonth must be ≤ toMonth' });
    }
    const zoneFilter = opts.zoneId != null ? Prisma.sql`AND z.zone_id = ${BigInt(opts.zoneId)}` : Prisma.empty;

    const raw = await this.prisma.$queryRaw<RawZmRow[]>(Prisma.sql`
      SELECT z.zm_id::text AS "zmId", u.name AS "zmName", z.zone_id::text AS "zoneId", zo.name AS "zoneName",
             z.month, z.overrides_total AS "overridesTotal", z.removals, z.deferrals, z.reorders, z.swaps,
             z.reassignments, z.split_batches AS "splitBatches", z.override_after_onsite AS "overrideAfterOnsite",
             z.manual_assignments AS "manualAssignments", z.auto_assigned_count AS "autoAssignedCount",
             z.zone_downtime_seconds AS "downtime", z.zone_window_seconds AS "window"
      FROM zm_performance_summary_monthly z
      JOIN users u ON u.user_id = z.zm_id
      JOIN zones zo ON zo.zone_id = z.zone_id
      WHERE z.month >= ${fromStart} AND z.month <= ${toStart} ${zoneFilter}
      ORDER BY u.name, z.month ASC`);

    const byZm = new Map<string, { meta: RawZmRow; months: RawZmRow[] }>();
    for (const r of raw) {
      let g = byZm.get(r.zmId);
      if (!g) {
        g = { meta: r, months: [] };
        byZm.set(r.zmId, g);
      }
      g.months.push(r);
    }

    const rows: ZmScorecardRow[] = [];
    const trend: ZmScorecardSeries[] = [];
    for (const { meta, months } of byZm.values()) {
      const sum = (pick: (r: RawZmRow) => number) => months.reduce((s, r) => s + pick(r), 0);
      const downtime = months.reduce((s, r) => s + Number(r.downtime), 0);
      const window = months.reduce((s, r) => s + Number(r.window), 0);
      const overrides = sum((r) => r.overridesTotal);
      const autoAssigned = sum((r) => r.autoAssignedCount);
      rows.push({
        zmId: meta.zmId,
        zmName: meta.zmName,
        zoneId: Number(meta.zoneId),
        zoneName: meta.zoneName,
        overrides,
        removals: sum((r) => r.removals),
        deferrals: sum((r) => r.deferrals),
        reorders: sum((r) => r.reorders),
        swaps: sum((r) => r.swaps),
        reassignments: sum((r) => r.reassignments),
        splitBatches: sum((r) => r.splitBatches),
        overrideAfterOnsite: sum((r) => r.overrideAfterOnsite),
        manualAssignments: sum((r) => r.manualAssignments),
        autoAssigned,
        overrideRatePct: ratePct(overrides, autoAssigned),
        zoneSlaCompliancePct: uptimePct(downtime, window),
      });
      trend.push({
        zmId: meta.zmId,
        zmName: meta.zmName,
        points: months.map((r) => ({
          month: r.month.toISOString().slice(0, 10),
          overrides: r.overridesTotal,
          overrideAfterOnsite: r.overrideAfterOnsite,
          manualAssignments: r.manualAssignments,
          overrideRatePct: ratePct(r.overridesTotal, r.autoAssignedCount),
          zoneSlaCompliancePct: uptimePct(Number(r.downtime), Number(r.window)),
        })),
      });
    }

    return { fromMonth: fromStart.toISOString().slice(0, 10), toMonth: toStart.toISOString().slice(0, 10), zoneId: opts.zoneId ?? null, rows, trend };
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

  /**
   * System Efficiency Report (Issue 42): the end-to-end operational pipeline metrics summed over a day
   * range from `system_efficiency_summary_daily`, with the Fleet/Zone/Company/Plant/device-type/SE
   * filters (a ZM is restricted to their own zone). Returns a fleet rollup plus a per-zone breakdown
   * (so auto-escalations-per-zone surfaces); all rates and average stage times are derived from the
   * additive numerators & denominators — no raw telemetry scan.
   */
  async systemEfficiency(scope: ReportScope, opts: SystemEfficiencyFilters = {}, now: Date = new Date()): Promise<SystemEfficiencyReport> {
    const fromDay = parseDay(opts.from ?? defaultDay(now));
    const toDay = parseDay(opts.to ?? opts.from ?? defaultDay(now));
    if (toDay.getTime() < fromDay.getTime()) {
      throw new BadRequestException({ code: 'INVALID_RANGE', hint: 'from must be ≤ to' });
    }
    const restrictZone = scope.role === 'ZONAL_MANAGER' ? scope.zoneId : (opts.zoneId ?? null);
    const filters = Prisma.join(
      [
        restrictZone != null ? Prisma.sql`AND s.zone_id = ${BigInt(restrictZone)}` : Prisma.empty,
        opts.companyId != null ? Prisma.sql`AND s.company_id = ${BigInt(opts.companyId)}` : Prisma.empty,
        opts.plantId != null ? Prisma.sql`AND s.plant_id = ${BigInt(opts.plantId)}` : Prisma.empty,
        opts.deviceType != null ? Prisma.sql`AND s.device_type = ${opts.deviceType}` : Prisma.empty,
        opts.seId != null ? Prisma.sql`AND s.se_id = ${opts.seId}::uuid` : Prisma.empty,
      ],
      ' ',
    );

    const raw = await this.prisma.$queryRaw<RawEfficiencyRow[]>(Prisma.sql`
      SELECT s.zone_id::text AS "zoneId", z.name AS "zoneName",
        COALESCE(SUM(s.failure_cycles_opened), 0)::int AS "failureCyclesOpened",
        COALESCE(SUM(s.tickets_created), 0)::int AS "ticketsCreated",
        COALESCE(SUM(s.troubleshoot_tickets_created), 0)::int AS "troubleshootTicketsCreated",
        COALESCE(SUM(s.auto_assignments), 0)::int AS "autoAssignments",
        COALESCE(SUM(s.manual_assignments), 0)::int AS "manualAssignments",
        COALESCE(SUM(s.overrides), 0)::int AS "overrides",
        COALESCE(SUM(s.cycles_resolved), 0)::int AS "cyclesResolved",
        COALESCE(SUM(s.verified_cycles), 0)::int AS "verifiedCycles",
        COALESCE(SUM(s.failed_verifications), 0)::int AS "failedVerifications",
        COALESCE(SUM(s.auto_recoveries), 0)::int AS "autoRecoveries",
        COALESCE(SUM(s.repeat_failures), 0)::int AS "repeatFailures",
        COALESCE(SUM(s.first_time_fixes), 0)::int AS "firstTimeFixes",
        COALESCE(SUM(s.component_pauses), 0)::int AS "componentPauses",
        COALESCE(SUM(s.aged_resolutions), 0)::int AS "agedResolutions",
        COALESCE(SUM(s.sla_compliant_resolutions), 0)::int AS "slaCompliantResolutions",
        COALESCE(SUM(s.auto_escalations), 0)::int AS "autoEscalations",
        COALESCE(SUM(s.downtime_seconds_sum), 0)::bigint AS "downtimeSecondsSum",
        COALESCE(SUM(s.detection_to_ticket_seconds_sum), 0)::bigint AS "detectionToTicketSecondsSum",
        COALESCE(SUM(s.detection_to_ticket_count), 0)::int AS "detectionToTicketCount",
        COALESCE(SUM(s.ticket_to_assignment_seconds_sum), 0)::bigint AS "ticketToAssignmentSecondsSum",
        COALESCE(SUM(s.ticket_to_assignment_count), 0)::int AS "ticketToAssignmentCount",
        COALESCE(SUM(s.assignment_to_onsite_seconds_sum), 0)::bigint AS "assignmentToOnsiteSecondsSum",
        COALESCE(SUM(s.assignment_to_onsite_count), 0)::int AS "assignmentToOnsiteCount",
        COALESCE(SUM(s.onsite_to_submission_seconds_sum), 0)::bigint AS "onsiteToSubmissionSecondsSum",
        COALESCE(SUM(s.onsite_to_submission_count), 0)::int AS "onsiteToSubmissionCount",
        COALESCE(SUM(s.submission_to_verification_seconds_sum), 0)::bigint AS "submissionToVerificationSecondsSum",
        COALESCE(SUM(s.submission_to_verification_count), 0)::int AS "submissionToVerificationCount",
        COALESCE(SUM(s.warehouse_fulfilment_seconds_sum), 0)::bigint AS "warehouseFulfilmentSecondsSum",
        COALESCE(SUM(s.warehouse_fulfilment_count), 0)::int AS "warehouseFulfilmentCount",
        COALESCE(SUM(s.recovery_closure_seconds_sum), 0)::bigint AS "recoveryClosureSecondsSum",
        COALESCE(SUM(s.recovery_closure_count), 0)::int AS "recoveryClosureCount"
      FROM system_efficiency_summary_daily s
      LEFT JOIN zones z ON z.zone_id = s.zone_id
      WHERE s.day >= ${fromDay} AND s.day <= ${toDay} ${filters}
      GROUP BY s.zone_id, z.name
      ORDER BY z.name NULLS LAST`);

    const byZone = raw.map((r) => ({ zoneId: r.zoneId, zoneName: r.zoneName, ...deriveEfficiency(r) }));
    const fleetSums = raw.reduce<RawEfficiencyRow>((acc, r) => addEfficiency(acc, r), emptyEfficiencyRow());

    return {
      from: fromDay.toISOString().slice(0, 10),
      to: toDay.toISOString().slice(0, 10),
      filters: {
        zoneId: restrictZone ?? null,
        companyId: opts.companyId ?? null,
        plantId: opts.plantId ?? null,
        deviceType: opts.deviceType ?? null,
        seId: opts.seId ?? null,
      },
      fleet: deriveEfficiency(fleetSums),
      byZone,
    };
  }
}

/** `(1 − downtime/window) × 100`, 2 decimals. A zero window (no eligible time) reports 100%. */
function uptimePct(downtime: number, window: number): number {
  if (window <= 0) return 100;
  return Math.round((1 - downtime / window) * 100 * 100) / 100;
}

/** `numerator/denominator × 100`, 2 decimals. A zero denominator (no assignments) reports 0%. */
function ratePct(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 100 * 100) / 100;
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

/** Current day as `YYYY-MM-DD` (UTC). */
function defaultDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Parse `YYYY-MM-DD` to the UTC midnight Date. */
function parseDay(day: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day ?? '');
  if (!m) throw new BadRequestException({ code: 'INVALID_DAY', hint: 'expected YYYY-MM-DD' });
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(dt.getTime())) throw new BadRequestException({ code: 'INVALID_DAY', hint: 'expected YYYY-MM-DD' });
  return dt;
}

/** `sum/count` rounded to a whole number of seconds, or null when there is no sample. */
function avgSeconds(sum: number, count: number): number | null {
  return count > 0 ? Math.round(sum / count) : null;
}

/** Derive the rendered efficiency metrics (rates + average stage times) from a summed cube row. */
function deriveEfficiency(r: RawEfficiencyRow): EfficiencyMetrics {
  const num = (v: number | bigint): number => Number(v);
  const totalAssignments = num(r.autoAssignments) + num(r.manualAssignments);
  const cyclesResolved = num(r.cyclesResolved);
  return {
    failureCyclesOpened: num(r.failureCyclesOpened),
    ticketsCreated: num(r.ticketsCreated),
    troubleshootTicketsCreated: num(r.troubleshootTicketsCreated),
    autoAssignments: num(r.autoAssignments),
    manualAssignments: num(r.manualAssignments),
    overrides: num(r.overrides),
    autoAssignmentRatePct: ratePct(num(r.autoAssignments), totalAssignments),
    manualAssignmentRatePct: ratePct(num(r.manualAssignments), totalAssignments),
    overrideRatePct: ratePct(num(r.overrides), totalAssignments),
    cyclesResolved,
    verifiedCycles: num(r.verifiedCycles),
    failedVerifications: num(r.failedVerifications),
    autoRecoveries: num(r.autoRecoveries),
    repeatFailures: num(r.repeatFailures),
    firstTimeFixes: num(r.firstTimeFixes),
    componentPauses: num(r.componentPauses),
    agedResolutions: num(r.agedResolutions),
    autoEscalations: num(r.autoEscalations),
    repeatFailureRatePct: ratePct(num(r.repeatFailures), num(r.failureCyclesOpened)),
    firstTimeFixRatePct: ratePct(num(r.firstTimeFixes), cyclesResolved),
    failedVerificationRatePct: ratePct(num(r.failedVerifications), num(r.verifiedCycles) + num(r.failedVerifications)),
    autoRecoveryRatePct: ratePct(num(r.autoRecoveries), cyclesResolved + num(r.autoRecoveries)),
    slaCompliancePct: ratePct(num(r.slaCompliantResolutions), cyclesResolved),
    totalDowntimeSeconds: num(r.downtimeSecondsSum),
    avgDowntimeSeconds: avgSeconds(num(r.downtimeSecondsSum), cyclesResolved),
    avgDetectionToTicketSeconds: avgSeconds(num(r.detectionToTicketSecondsSum), num(r.detectionToTicketCount)),
    avgTicketToAssignmentSeconds: avgSeconds(num(r.ticketToAssignmentSecondsSum), num(r.ticketToAssignmentCount)),
    avgAssignmentToOnsiteSeconds: avgSeconds(num(r.assignmentToOnsiteSecondsSum), num(r.assignmentToOnsiteCount)),
    avgOnsiteToSubmissionSeconds: avgSeconds(num(r.onsiteToSubmissionSecondsSum), num(r.onsiteToSubmissionCount)),
    avgSubmissionToVerificationSeconds: avgSeconds(num(r.submissionToVerificationSecondsSum), num(r.submissionToVerificationCount)),
    avgWarehouseFulfilmentSeconds: avgSeconds(num(r.warehouseFulfilmentSecondsSum), num(r.warehouseFulfilmentCount)),
    avgRecoveryClosureSeconds: avgSeconds(num(r.recoveryClosureSecondsSum), num(r.recoveryClosureCount)),
  };
}

const EFFICIENCY_SUM_FIELDS: (keyof RawEfficiencyRow)[] = [
  'failureCyclesOpened', 'ticketsCreated', 'troubleshootTicketsCreated', 'autoAssignments', 'manualAssignments',
  'overrides', 'cyclesResolved', 'verifiedCycles', 'failedVerifications', 'autoRecoveries', 'repeatFailures',
  'firstTimeFixes', 'componentPauses', 'agedResolutions', 'slaCompliantResolutions', 'autoEscalations',
  'downtimeSecondsSum', 'detectionToTicketSecondsSum', 'detectionToTicketCount', 'ticketToAssignmentSecondsSum',
  'ticketToAssignmentCount', 'assignmentToOnsiteSecondsSum', 'assignmentToOnsiteCount', 'onsiteToSubmissionSecondsSum',
  'onsiteToSubmissionCount', 'submissionToVerificationSecondsSum', 'submissionToVerificationCount',
  'warehouseFulfilmentSecondsSum', 'warehouseFulfilmentCount', 'recoveryClosureSecondsSum', 'recoveryClosureCount',
];

function emptyEfficiencyRow(): RawEfficiencyRow {
  const base = { zoneId: null, zoneName: null } as RawEfficiencyRow;
  const rec = base as unknown as Record<string, number>;
  for (const f of EFFICIENCY_SUM_FIELDS) rec[f] = 0;
  return base;
}

function addEfficiency(acc: RawEfficiencyRow, r: RawEfficiencyRow): RawEfficiencyRow {
  const a = acc as unknown as Record<string, number | bigint>;
  const b = r as unknown as Record<string, number | bigint>;
  for (const f of EFFICIENCY_SUM_FIELDS) a[f] = Number(a[f]) + Number(b[f]);
  return acc;
}
