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

/**
 * **When the numbers were computed** — carried by every `/reports/*` payload (#347).
 *
 * ISO-8601, or `null` when the report's window has no cube row at all. For the four cube-backed
 * reports this is `MAX(computed_at)` **over exactly the rows that report read**, so a filter that
 * lands on a corner of the cube the sweep has not rebuilt reports that corner's age rather than the
 * newest row in the table. For the two live distributions (work-type mix, verification outcomes) it
 * is the instant the server ran the query, because there is no cube between the reader and the rows.
 *
 * Why the field exists at all: all four cubes have always stored `computed_at` and no payload ever
 * returned it, so the admin's "Data as of" line was `new Date()` in the browser at the moment the
 * fetch resolved. That stamp cannot go stale by construction — a sweep dead for two days still drew a
 * timestamp from this morning over two-day-old numbers. `null` is deliberately not "now" for the same
 * reason `uptimePct` is not `100` at a zero window (#346): an absence of computation is not a
 * computation, and the surface has to say so rather than format a plausible-looking time.
 */
export interface DataAsOf {
  dataAsOf: string | null;
}

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

export interface RootCauseReport extends DataAsOf {
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

export interface SystemEfficiencyReport extends DataAsOf {
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
  /** `MAX(computed_at)` for this group — never summed (see `EFFICIENCY_SUM_FIELDS`), only max'd. */
  computedAt: Date | null;
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
  /**
   * Zone Fleet-Uptime compliance over the range (time-weighted), 0–100, 2 decimals — **`null` when the
   * zone had no eligible device-time in the range** (#346). It is the same {@link uptimePct}
   * computation the Fleet Uptime report uses, so it inherited the same fabricated `100`: on this page
   * that crowned the emptiest zone as the best-run one.
   */
  zoneSlaCompliancePct: number | null;
}
export interface ZmScorecardTrendPoint {
  month: string;
  overrides: number;
  overrideAfterOnsite: number;
  manualAssignments: number;
  overrideRatePct: number;
  /** `null` for a month with no eligible device-time — a gap on the trend, never a plotted 100. */
  zoneSlaCompliancePct: number | null;
}
export interface ZmScorecardSeries {
  zmId: string;
  zmName: string;
  points: ZmScorecardTrendPoint[];
}
export interface ZmScorecardReport extends DataAsOf {
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
  computedAt: Date | null;
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
  /**
   * Time-weighted online % over this group's eligible devices, 0–100, 2 decimals — **`null` when the
   * group has no eligible device-time in the month** (#346). See {@link uptimePct}: a zero window is
   * an absence of measurement, and every rendering of this field must say so rather than print a
   * number. A `null` here does not mean the group is empty: `eligibleDeviceCount` can be non-zero for
   * a month that simply has not elapsed.
   */
  uptimePct: number | null;
  autoRecoveryClosures: number;
  seRepairedClosures: number;
}

export interface FleetUptimeReport extends DataAsOf {
  month: string; // ISO date of the month's first day
  groupBy: FleetUptimeGroupBy;
  fleet: {
    eligibleDeviceCount: number;
    /** Fleet-wide uptime, or `null` for a month with no eligible device-time — see {@link FleetUptimeRow}. */
    uptimePct: number | null;
    autoRecoveryClosures: number;
    seRepairedClosures: number;
  };
  rows: FleetUptimeRow[];
}

type RawGroupRow = {
  id: string;
  name: string;
  computedAt: Date | null;
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
export interface SoftInactiveTrend extends DataAsOf {
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

/** Canonical work-type order (CONTEXT WorkType) — the mix zero-fills the full set. */
export const WORK_TYPES = ['TROUBLESHOOT', 'INSTALL', 'RECOVERY'] as const;
export type WorkTypeKey = (typeof WORK_TYPES)[number];

/**
 * Verification-outcome buckets, canonical order. `PENDING` is a run whose `outcome` is still null
 * (verification in flight) — the reference panel shows it as its own row.
 */
export const VERIFY_OUTCOME_KEYS = ['CLOSED', 'CLOSED_AUTO_RECOVERY', 'PARTIAL_RECOVERY', 'FAILED_VERIFICATION', 'FAILED_ACTIVATION', 'PENDING'] as const;
export type VerifyOutcomeKey = (typeof VERIFY_OUTCOME_KEYS)[number];

/** Shared day-range + dimension filters for the two Issue-90 distribution reports. */
export interface DistributionFilters {
  from?: string; // YYYY-MM-DD (inclusive); defaults to 29 days before `to`
  to?: string; // YYYY-MM-DD (inclusive); defaults to today
  zoneId?: number | null;
  companyId?: number | null;
  plantId?: number | null;
}

export interface WorkTypeMixReport extends DataAsOf {
  from: string;
  to: string;
  total: number;
  filters: { zoneId: number | null; companyId: number | null; plantId: number | null };
  rows: { workType: WorkTypeKey; count: number; pct: number }[];
}

/**
 * #357 — one escalated run, with the reason it was escalated for.
 *
 * The distribution rows answer "how much"; this answers "which, and why", which is the question a
 * reviewer actually opens the outcomes panel with. It could not be answered before because the reason
 * lived only in `audit_logs.metadata` — a table this aggregation does not join and cannot filter on —
 * so the report could count escalations and never explain one.
 */
export interface VerificationEscalationRow {
  ticketId: string;
  deviceId: string;
  /** The run's own verdict, which is NOT the ticket's status: a run may be escalated after it failed. */
  outcome: VerifyOutcomeKey;
  escalationReason: string;
  startedAt: string;
}

export interface VerificationOutcomesReport extends DataAsOf {
  from: string;
  to: string;
  total: number;
  /** Runs in the window carrying the fraud flag — a cross-cutting count, not an outcome bucket. */
  fraudFlagged: number;
  filters: { zoneId: number | null; companyId: number | null; plantId: number | null };
  rows: { outcome: VerifyOutcomeKey; count: number; pct: number }[];
  /**
   * #357 — runs in the window whose ticket is escalated RIGHT NOW, newest first, capped at
   * {@link ESCALATION_DETAIL_LIMIT}. A de-escalated run drops out of this list (the column is the live
   * verdict, not the history — see `VerificationRun.escalationReason`), which is what makes the list
   * a work queue rather than a growing archive.
   */
  escalations: VerificationEscalationRow[];
}

// ---- SE productivity (#365, design `docs/ui/desktop/approved-designs/se-productivity-report.html`) ----

export type SeProductivityGranularity = 'weekly' | 'monthly';
/** `all`, or one member of the `coverage_type` enum. The page's Coverage control. */
export type SeCoverageFilter = 'all' | 'DEDICATED' | 'MULTI_PLANT' | 'FLOATING';
export const SE_COVERAGE_FILTERS: SeCoverageFilter[] = ['all', 'DEDICATED', 'MULTI_PLANT', 'FLOATING'];
export const SE_PRODUCTIVITY_GRANULARITIES: SeProductivityGranularity[] = ['weekly', 'monthly'];

/**
 * **The small-sample floor: rates are withheld below ten closures.**
 *
 * An operator constraint attached to the approved design, and enforced *here* rather than in the page
 * — a suppressed rate that the payload still carries is one CSV export away from being acted on, and
 * the number it would show is noise either way. A floating SE with six closures has no meaningful
 * first-time-fix percentage: one bad job moves it 17 points. Ten is the point at which a single
 * outcome stops being able to swing the figure by more than ten points, which is the smallest bar
 * worth defending and is stated on the page footer so nobody has to guess where the dashes come from.
 *
 * The **counts are never suppressed.** Six closures is a true fact about six jobs, and hiding it would
 * conceal the one thing about a low-volume engineer a manager should see.
 */
export const SE_PRODUCTIVITY_RATE_MIN_SAMPLE = 10;

export interface SeProductivityRow {
  seId: string;
  name: string;
  coverageType: 'DEDICATED' | 'MULTI_PLANT' | 'FLOATING';
  zoneId: string;
  zoneName: string | null;
  /** `repairClosures + departureClosures` — the sample size the rate floor is judged against. */
  closures: number;
  /** Closures the engineer earned: `closure_type IS NULL`, the verification service's own close. */
  repairClosures: number;
  /** `DEVICE_UNDEPLOYED_CLOSE` — the vehicle left the fleet. Shown, never credited (audit F7). */
  departureClosures: number;
  firstTimeFixes: number;
  /** `null` = withheld (below {@link SE_PRODUCTIVITY_RATE_MIN_SAMPLE}) or no denominator. Never 0-as-unknown. */
  firstTimeFixRatePct: number | null;
  verificationsDecided: number;
  failedVerifications: number;
  failedVerificationRatePct: number | null;
  onsiteToSubmissionCount: number;
  /** `null` when the engineer logged no on-site → submission pair in the window. */
  avgOnsiteToSubmissionSeconds: number | null;
  /** True when the rate columns are `null` **because of the floor** rather than because of no data. */
  ratesSuppressed: boolean;
}

export interface SeProductivityReport extends DataAsOf {
  granularity: SeProductivityGranularity;
  from: string; // ISO date, inclusive
  to: string; // ISO date, inclusive
  rateMinSample: number;
  /** The **clamped** zone — a ZM's own, whatever they asked for. The page's scope chip reads this. */
  filters: { zoneId: number | null; coverage: SeCoverageFilter };
  totals: { engineers: number; closures: number; repairClosures: number; departureClosures: number };
  rows: SeProductivityRow[];
}

export interface SeProductivityFilters {
  granularity?: SeProductivityGranularity;
  /** `YYYY-MM` — the window when `granularity` is `monthly`. Defaults to the current month. */
  month?: string;
  /** `YYYY-MM-DD` — any day in the wanted week when `granularity` is `weekly`. Defaults to today. */
  weekOf?: string;
  zoneId?: number | null;
  coverage?: SeCoverageFilter;
}

interface RawSeProductivityRow {
  seId: string;
  name: string;
  coverageType: 'DEDICATED' | 'MULTI_PLANT' | 'FLOATING';
  zoneId: string;
  zoneName: string | null;
  repairClosures: number;
  departureClosures: number;
  firstTimeFixes: number;
  verificationsDecided: number;
  failedVerifications: number;
  onsiteToSubmissionCount: number;
  onsiteToSubmissionSecondsSum: bigint;
}

/**
 * **Which engineer a ticket's outcome belongs to.**
 *
 * One rule, used by every column, because two rules would let the Repair and Departure counts on one
 * row describe two different people. The engineer who *did the work* if there is a submitted form;
 * otherwise the engineer the ticket was last assigned to.
 *
 * The fallback is not a nicety — it is the only attribution a **departure** closure can have. Nobody
 * submitted a form: the master sync observed the vehicle leaving and closed the ticket. Without the
 * assignment leg those closures would vanish from the report entirely, which is the same information
 * loss as F7 with the opposite sign: the column exists precisely so a manager can see that eleven of
 * an engineer's forty-two closures were not work.
 */
function attributedSe(ticketColumn: string): Prisma.Sql {
  const col = Prisma.raw(ticketColumn);
  return Prisma.sql`COALESCE(
    (SELECT ts.se_id FROM troubleshooting_submissions ts WHERE ts.ticket_id = ${col} ORDER BY ts.submitted_at DESC LIMIT 1),
    (SELECT pba.se_id
       FROM batch_assignment_tickets bat
       JOIN plant_batch_assignments pba ON pba.batch_id = bat.batch_id
      WHERE bat.ticket_id = ${col}
      ORDER BY bat.id DESC LIMIT 1)
  )`;
}

/**
 * The escalation detail list is a review queue, not an export: a window with hundreds of live
 * escalations is a staffing emergency, not a paging problem, and an uncapped detail array inside an
 * aggregate payload is how a report becomes the slowest endpoint in the product. The cap is stated
 * here rather than buried in the SQL so the day it starts truncating is a legible fact.
 */
const ESCALATION_DETAIL_LIMIT = 200;

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
      dataAsOf: maxComputedAt(rows),
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

    // This report reads a capture HISTORY, not a cube: its "computed at" is the newest capture in the
    // window, which is exactly what `soft_inactive_count_history.captured_at` records.
    const dataAsOf = maxDate(rows.map((r) => r.capturedAt));

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
    return { sinceDays: days, dataAsOf, zones: [...byZone.values()] };
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

    const rows = await this.prisma.$queryRaw<{ category: string; count: bigint; computedAt: Date | null }[]>(Prisma.sql`
      SELECT root_cause_category::text AS category, COALESCE(SUM(submission_count), 0)::bigint AS count,
             MAX(computed_at) AS "computedAt"
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
      dataAsOf: maxComputedAt(rows),
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
             z.zone_downtime_seconds AS "downtime", z.zone_window_seconds AS "window",
             z.computed_at AS "computedAt"
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

    return {
      fromMonth: fromStart.toISOString().slice(0, 10),
      toMonth: toStart.toISOString().slice(0, 10),
      zoneId: opts.zoneId ?? null,
      dataAsOf: maxComputedAt(raw),
      rows,
      trend,
    };
  }

  /**
   * Work-type mix (Issue 90): ticket counts per work type over a `created_at` day range (default the
   * last 30 days), zero-filled over the full WorkType set. Direct aggregation over `tickets` — a
   * single indexed count, no summary table needed at this cardinality. A ZONAL_MANAGER is pinned to
   * their own zone (via the ticket's plant); CSM / Operations Head see all zones and may filter one.
   */
  async workTypeMix(scope: ReportScope, opts: DistributionFilters = {}, now: Date = new Date()): Promise<WorkTypeMixReport> {
    const { fromDay, toEnd, meta } = dayWindow(opts, now);
    const filters = this.distributionFilters(scope, opts, Prisma.sql`t.company_id`, Prisma.sql`t.plant_id`);

    const rows = await this.prisma.$queryRaw<{ workType: string; count: number }[]>(Prisma.sql`
      SELECT t.work_type::text AS "workType", COUNT(*)::int AS count
      FROM tickets t
      JOIN plants p ON p.plant_id = t.plant_id
      WHERE t.created_at >= ${fromDay} AND t.created_at < ${toEnd} ${filters.sql}
      GROUP BY t.work_type`);

    const counts = new Map(rows.map((r) => [r.workType, r.count]));
    const total = rows.reduce((s, r) => s + r.count, 0);
    return {
      ...meta,
      total,
      // No cube sits between the reader and `tickets`, so the data time IS the query instant — the
      // server's, never the browser's (#347).
      dataAsOf: now.toISOString(),
      filters: filters.echo,
      rows: WORK_TYPES.map((workType) => ({ workType, count: counts.get(workType) ?? 0, pct: ratePct(counts.get(workType) ?? 0, total) })),
    };
  }

  /**
   * Verification-outcome distribution (Issue 90): run counts per outcome over a `started_at` day range
   * (default the last 30 days), zero-filled over the outcome set plus `PENDING` (outcome still null).
   * `fraudFlagged` counts flagged runs across the same window — a cross-cutting signal, not a bucket.
   * Same scoping as `workTypeMix` (zone comes via the run's ticket's plant).
   */
  async verificationOutcomes(scope: ReportScope, opts: DistributionFilters = {}, now: Date = new Date()): Promise<VerificationOutcomesReport> {
    const { fromDay, toEnd, meta } = dayWindow(opts, now);
    const filters = this.distributionFilters(scope, opts, Prisma.sql`t.company_id`, Prisma.sql`t.plant_id`);

    const rows = await this.prisma.$queryRaw<{ outcome: string; count: number; fraudFlagged: number }[]>(Prisma.sql`
      SELECT COALESCE(vr.outcome::text, 'PENDING') AS outcome, COUNT(*)::int AS count,
             COUNT(*) FILTER (WHERE vr.fraud_flag)::int AS "fraudFlagged"
      FROM verification_runs vr
      JOIN tickets t ON t.ticket_id = vr.ticket_id
      JOIN plants p ON p.plant_id = t.plant_id
      WHERE vr.started_at >= ${fromDay} AND vr.started_at < ${toEnd} ${filters.sql}
      GROUP BY COALESCE(vr.outcome::text, 'PENDING')`);

    // #357 — the reason column, from the run row rather than from `audit_logs`. Same window, same
    // scope filters, same join shape as the aggregate above, so a ZM's escalation list is clamped by
    // construction and cannot drift from the counts beside it.
    const escalated = await this.prisma.$queryRaw<
      { ticketId: string; deviceId: string; outcome: string; escalationReason: string; startedAt: Date }[]
    >(Prisma.sql`
      SELECT vr.ticket_id AS "ticketId", vr.device_id AS "deviceId",
             COALESCE(vr.outcome::text, 'PENDING') AS outcome,
             vr.escalation_reason AS "escalationReason", vr.started_at AS "startedAt"
      FROM verification_runs vr
      JOIN tickets t ON t.ticket_id = vr.ticket_id
      JOIN plants p ON p.plant_id = t.plant_id
      WHERE vr.started_at >= ${fromDay} AND vr.started_at < ${toEnd}
        AND vr.escalation_reason IS NOT NULL ${filters.sql}
      ORDER BY vr.started_at DESC
      LIMIT ${ESCALATION_DETAIL_LIMIT}`);

    const counts = new Map(rows.map((r) => [r.outcome, r.count]));
    const total = rows.reduce((s, r) => s + r.count, 0);
    return {
      ...meta,
      total,
      fraudFlagged: rows.reduce((s, r) => s + r.fraudFlagged, 0),
      // Live aggregation over `verification_runs` — see `workTypeMix` (#347).
      dataAsOf: now.toISOString(),
      filters: filters.echo,
      rows: VERIFY_OUTCOME_KEYS.map((outcome) => ({ outcome, count: counts.get(outcome) ?? 0, pct: ratePct(counts.get(outcome) ?? 0, total) })),
      escalations: escalated.map((e) => ({
        ticketId: e.ticketId,
        deviceId: String(e.deviceId),
        outcome: e.outcome as VerifyOutcomeKey,
        escalationReason: e.escalationReason,
        startedAt: e.startedAt.toISOString(),
      })),
    };
  }

  /** ZM-pinned zone + optional company/plant filters shared by the two distribution reports. */
  private distributionFilters(scope: ReportScope, opts: DistributionFilters, companyCol: Prisma.Sql, plantCol: Prisma.Sql) {
    const restrictZone = scope.role === 'ZONAL_MANAGER' ? scope.zoneId : (opts.zoneId ?? null);
    const sql = Prisma.join(
      [
        restrictZone != null ? Prisma.sql`AND p.zone_id = ${BigInt(restrictZone)}` : Prisma.empty,
        opts.companyId != null ? Prisma.sql`AND ${companyCol} = ${BigInt(opts.companyId)}` : Prisma.empty,
        opts.plantId != null ? Prisma.sql`AND ${plantCol} = ${BigInt(opts.plantId)}` : Prisma.empty,
      ],
      ' ',
    );
    return { sql, echo: { zoneId: restrictZone ?? null, companyId: opts.companyId ?? null, plantId: opts.plantId ?? null } };
  }

  private queryGroups(groupBy: FleetUptimeGroupBy, monthStart: Date, zoneFilter: Prisma.Sql): Promise<RawGroupRow[]> {
    const select = Prisma.sql`
      MAX(s.computed_at) AS "computedAt",
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
        MAX(s.computed_at) AS "computedAt",
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
      dataAsOf: maxComputedAt(raw),
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

  /**
   * **SE productivity** (#365, PRD story 25) — one row per engineer for a week or a month: closures
   * split into repairs and departures, first-time-fix rate, failed-verification rate, and average
   * on-site → submission time. Zone-clamped for a ZM; CSM / Operations Head see every zone.
   *
   * Three things about this method are decisions, not detail.
   *
   * **1. The roster is the row set, not the activity.** Every active engineer in scope gets a row,
   * including one who closed nothing. The page answers "which of my engineers needs attention", and an
   * engineer who did no work in a month is an answer to that question — dropping them would make the
   * emptiest case invisible.
   *
   * **2. Repair and Departure are separate columns, structurally** (audit F7,
   * {@link FleetUptimeAggregationService}). `closure_type IS NULL` is the verification service's own
   * close and the only closure an engineer earned; `DEVICE_UNDEPLOYED_CLOSE` is a vehicle leaving the
   * fleet. Summed together — as `se_repaired_closures` did — an engineer with unlucky plants outranks
   * one who repaired devices, on the page staffing decisions are made from.
   *
   * **3. It reads the source tables, not a cube — and this is a departure from the approved design's
   * "no live recomputation", made deliberately.** No summary table can serve it: the `se_id` dimension
   * of `system_efficiency_summary_daily` is populated by legs 5 and 7 alone (auto-assignments and
   * overrides), every closure / verification / stage-time leg writes `se_id = NULL`, and no cube
   * anywhere carries a closure-type split. Serving this from a cube needs new columns, and
   * `schema.prisma` was owned by another slice in this round. So it follows the pattern
   * `workTypeMix` / `verificationOutcomes` already establish in this service — a bounded live read over
   * `tickets` with an honest `dataAsOf` of "now" (#347) — rather than a fabricated cube stamp. The
   * window is one week or one month of one zone's tickets, which is nothing like the multi-year
   * telemetry scans the cubes exist to prevent. The follow-up that would restore the cube path is
   * recorded in `docs/progress/365-se-productivity-report.md`.
   */
  async seProductivity(scope: ReportScope, opts: SeProductivityFilters = {}, now: Date = new Date()): Promise<SeProductivityReport> {
    const granularity = opts.granularity ?? 'monthly';
    const { from, toExclusive } = seProductivityWindow(granularity, opts, now);
    // The clamp is server-side and unconditional: the page's zone dropdown is a convenience, and a ZM
    // who picks another zone gets their own back, echoed in `filters.zoneId` so the chip can say so.
    const restrictZone = scope.role === 'ZONAL_MANAGER' ? scope.zoneId : (opts.zoneId ?? null);
    const coverage = opts.coverage ?? 'all';

    const rosterFilters = Prisma.join(
      [
        restrictZone != null ? Prisma.sql`AND em.zone_id = ${BigInt(restrictZone)}` : Prisma.empty,
        coverage !== 'all' ? Prisma.sql`AND em.coverage_type = ${coverage}::coverage_type` : Prisma.empty,
      ],
      ' ',
    );

    const raw = await this.prisma.$queryRaw<RawSeProductivityRow[]>(Prisma.sql`
      WITH roster AS (
        SELECT em.engineer_id AS se_id, u.name AS name, em.coverage_type::text AS coverage_type,
               em.zone_id AS zone_id, z.name AS zone_name
        FROM engineer_master em
        JOIN users u ON u.user_id = em.engineer_id
        LEFT JOIN zones z ON z.zone_id = em.zone_id
        WHERE em.is_active = TRUE ${rosterFilters}
      ),
      closures AS (
        SELECT c.se_id,
               COUNT(*) FILTER (WHERE c.closure_type IS NULL)::int AS repair,
               COUNT(*) FILTER (WHERE c.closure_type IS NOT NULL)::int AS departure,
               COUNT(*) FILTER (WHERE c.closure_type IS NULL AND c.first_time)::int AS ftf
        FROM (
          SELECT t.closure_type,
                 -- The same first-time-fix predicate system_efficiency_summary_daily leg 3 uses, so an
                 -- SE's rate here and the fleet rate on the System Efficiency page are the same
                 -- measure at two grains rather than two definitions that disagree by a few points.
                 (fc.state = 'VERIFIED' AND NOT fc.repeat_failure AND fc.sla_accumulated_pause_seconds = 0) AS first_time,
                 ${attributedSe('t.ticket_id')} AS se_id
          FROM tickets t
          JOIN failure_cycles fc ON fc.cycle_id = t.failure_cycle_id
          WHERE t.work_type = 'TROUBLESHOOT' AND t.status = 'CLOSED'
            AND t.closed_at >= ${from} AND t.closed_at < ${toExclusive}
            AND (t.closure_type IS NULL OR t.closure_type = 'DEVICE_UNDEPLOYED_CLOSE')
        ) c
        WHERE c.se_id IS NOT NULL
        GROUP BY c.se_id
      ),
      verifications AS (
        SELECT v.se_id,
               COUNT(*)::int AS decided,
               COUNT(*) FILTER (WHERE v.outcome = 'FAILED_VERIFICATION')::int AS failed
        FROM (
          SELECT vr.outcome, ${attributedSe('vr.ticket_id')} AS se_id
          FROM verification_runs vr
          WHERE vr.outcome_at >= ${from} AND vr.outcome_at < ${toExclusive}
            AND vr.outcome IN ('CLOSED', 'FAILED_VERIFICATION')
        ) v
        WHERE v.se_id IS NOT NULL
        GROUP BY v.se_id
      ),
      stage AS (
        SELECT s.se_id, COUNT(*)::int AS cnt, COALESCE(SUM(s.secs), 0)::bigint AS secs
        FROM (
          SELECT sub.se_id, EXTRACT(EPOCH FROM (sub.submitted_at - os.onsite_at)) AS secs
          FROM (
            SELECT ticket_id, MIN(submitted_at) AS submitted_at,
                   (ARRAY_AGG(se_id ORDER BY submitted_at))[1] AS se_id
            FROM troubleshooting_submissions
            WHERE submitted_at >= ${from} AND submitted_at < ${toExclusive}
            GROUP BY ticket_id
          ) sub
          CROSS JOIN LATERAL (
            SELECT MIN(ss.set_at) AS onsite_at FROM soft_states ss
            WHERE ss.ticket_id = sub.ticket_id AND ss.type = 'ON_SITE'
          ) os
          WHERE os.onsite_at IS NOT NULL AND os.onsite_at <= sub.submitted_at
        ) s
        GROUP BY s.se_id
      )
      SELECT r.se_id::text AS "seId", r.name AS "name", r.coverage_type AS "coverageType",
             r.zone_id::text AS "zoneId", r.zone_name AS "zoneName",
             COALESCE(c.repair, 0)::int AS "repairClosures",
             COALESCE(c.departure, 0)::int AS "departureClosures",
             COALESCE(c.ftf, 0)::int AS "firstTimeFixes",
             COALESCE(v.decided, 0)::int AS "verificationsDecided",
             COALESCE(v.failed, 0)::int AS "failedVerifications",
             COALESCE(st.cnt, 0)::int AS "onsiteToSubmissionCount",
             COALESCE(st.secs, 0)::bigint AS "onsiteToSubmissionSecondsSum"
      FROM roster r
      LEFT JOIN closures c ON c.se_id = r.se_id
      LEFT JOIN verifications v ON v.se_id = r.se_id
      LEFT JOIN stage st ON st.se_id = r.se_id
      -- **By name, ascending.** The design forbids a pre-sorted worst-first order: this is a
      -- diagnostic surface, not a league table, and the order the page opens in must not itself be a
      -- ranking. The table is sortable; that is the reader's choice to make, not the server's.
      ORDER BY r.name ASC`);

    const rows = raw.map(deriveSeProductivity);
    return {
      granularity,
      from: from.toISOString().slice(0, 10),
      to: new Date(toExclusive.getTime() - 86_400_000).toISOString().slice(0, 10),
      rateMinSample: SE_PRODUCTIVITY_RATE_MIN_SAMPLE,
      // Live read, so the stamp is the instant the server answered — the same honest posture #347 gave
      // the other two non-cube reports. Never a cube's `computed_at`: there is no cube behind this.
      dataAsOf: now.toISOString(),
      filters: { zoneId: restrictZone ?? null, coverage },
      totals: {
        engineers: rows.length,
        closures: rows.reduce((n, r) => n + r.closures, 0),
        repairClosures: rows.reduce((n, r) => n + r.repairClosures, 0),
        departureClosures: rows.reduce((n, r) => n + r.departureClosures, 0),
      },
      rows,
    };
  }
}

/**
 * The report window. Monthly is the calendar month; weekly is the **Monday-to-Sunday week containing
 * `weekOf`** — resolved from any day in it, so a caller never has to know which day a week starts on
 * and a link to "the week of the 17th" is stable whichever day of it was clicked.
 */
function seProductivityWindow(
  granularity: SeProductivityGranularity,
  opts: SeProductivityFilters,
  now: Date,
): { from: Date; toExclusive: Date } {
  if (granularity === 'weekly') {
    const day = parseDay(opts.weekOf ?? defaultDay(now));
    // getUTCDay: 0 = Sunday. Shift so Monday is 0, then step back that many days.
    const monday = new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * 86_400_000);
    return { from: monday, toExclusive: new Date(monday.getTime() + 7 * 86_400_000) };
  }
  const start = parseMonth(opts.month ?? defaultMonth(now));
  return { from: start, toExclusive: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)) };
}

/**
 * Counts through, rates gated. See {@link SE_PRODUCTIVITY_RATE_MIN_SAMPLE} for why the gate exists and
 * why it lives on the server. A rate is also `null` when its own denominator is empty — an engineer
 * with ten departure closures and no repairs has no first-time-fix rate at all, and `0%` would read as
 * "fixed nothing on the first visit" rather than "never had a first visit to measure".
 */
function deriveSeProductivity(r: RawSeProductivityRow): SeProductivityRow {
  const closures = r.repairClosures + r.departureClosures;
  const suppressed = closures < SE_PRODUCTIVITY_RATE_MIN_SAMPLE;
  const rate = (numerator: number, denominator: number): number | null =>
    suppressed || denominator <= 0 ? null : ratePct(numerator, denominator);
  return {
    seId: r.seId,
    name: r.name,
    coverageType: r.coverageType,
    zoneId: r.zoneId,
    zoneName: r.zoneName,
    closures,
    repairClosures: r.repairClosures,
    departureClosures: r.departureClosures,
    firstTimeFixes: r.firstTimeFixes,
    firstTimeFixRatePct: rate(r.firstTimeFixes, r.repairClosures),
    verificationsDecided: r.verificationsDecided,
    failedVerifications: r.failedVerifications,
    failedVerificationRatePct: rate(r.failedVerifications, r.verificationsDecided),
    onsiteToSubmissionCount: r.onsiteToSubmissionCount,
    // Not gated by the closure floor: an average of a stated sample size is not a rate, and the count
    // travels with it so the reader can see what it averages over.
    avgOnsiteToSubmissionSeconds: avgSeconds(Number(r.onsiteToSubmissionSecondsSum), r.onsiteToSubmissionCount),
    ratesSuppressed: suppressed,
  };
}

/**
 * `(1 − downtime/window) × 100`, 2 decimals — or **`null` when the window is zero**.
 *
 * #346. This used to answer `100`, and that was not a harmless default. `(1 − downtime/window)` is
 * undefined at a zero window, and of every value it could have picked, `100` is the one that reads as
 * a *perfect* fleet — the best possible news, indistinguishable from a real month in which nothing
 * broke. It was also not an edge case: the report defaults to the current month, and the cube crons
 * only ever wrote the previous one, so the first number the Reports page showed was fabricated.
 *
 * `null` is chosen over `0` for the same reason `100` was wrong in the other direction: a zero
 * denominator is an absence of measurement, not a measurement of zero. Every consumer of this value —
 * the fleet total, the zone/company/plant rows, the ZM scorecard's zone SLA compliance — is typed
 * `number | null` so the absence has to be handled at the point it is rendered, rather than silently
 * formatted into a percentage.
 */
function uptimePct(downtime: number, window: number): number | null {
  if (window <= 0) return null;
  return Math.round((1 - downtime / window) * 100 * 100) / 100;
}

/**
 * `MAX(computed_at)` across the cube rows a report read, ISO-8601 — or `null` when it read none
 * (#347). Taken in JS rather than as a second round trip: every cube query already groups, so each
 * group's own `MAX(computed_at)` comes back for free and the report-wide max is a fold over rows that
 * are already in hand.
 */
function maxComputedAt(rows: { computedAt: Date | null }[]): string | null {
  return maxDate(rows.map((r) => r.computedAt));
}

/** The newest of a set of possibly-absent instants, ISO-8601, or `null` when there is none. */
function maxDate(dates: (Date | null | undefined)[]): string | null {
  let newest: number | null = null;
  for (const d of dates) {
    if (!d) continue;
    const t = d.getTime();
    if (Number.isNaN(t)) continue;
    if (newest === null || t > newest) newest = t;
  }
  return newest === null ? null : new Date(newest).toISOString();
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
  // Date.UTC silently rolls over out-of-range parts (2026-13-01 → 2027-01-01) — reject those too.
  if (Number.isNaN(dt.getTime()) || dt.getUTCMonth() !== Number(m[2]) - 1 || dt.getUTCDate() !== Number(m[3])) {
    throw new BadRequestException({ code: 'INVALID_DAY', hint: 'expected YYYY-MM-DD' });
  }
  return dt;
}

/**
 * Resolve a `DistributionFilters` day range: inclusive `from`/`to` days, `to` defaulting to today and
 * `from` to 29 days earlier (a 30-day window). `toEnd` is the exclusive upper bound for timestamptz
 * comparison. `meta` carries the echoed ISO day strings for the response.
 */
function dayWindow(opts: { from?: string; to?: string }, now: Date): { fromDay: Date; toEnd: Date; meta: { from: string; to: string } } {
  const toDay = parseDay(opts.to ?? defaultDay(now));
  const fromDay = opts.from !== undefined ? parseDay(opts.from) : new Date(toDay.getTime() - 29 * 86_400_000);
  if (toDay.getTime() < fromDay.getTime()) {
    throw new BadRequestException({ code: 'INVALID_RANGE', hint: 'from must be ≤ to' });
  }
  return {
    fromDay,
    toEnd: new Date(toDay.getTime() + 86_400_000),
    meta: { from: fromDay.toISOString().slice(0, 10), to: toDay.toISOString().slice(0, 10) },
  };
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
  // `computedAt` is not a summable field — the report-wide stamp is max'd off the raw rows, not the
  // fleet fold — so the accumulator carries it as null and `addEfficiency` never touches it.
  const base = { zoneId: null, zoneName: null, computedAt: null } as RawEfficiencyRow;
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
