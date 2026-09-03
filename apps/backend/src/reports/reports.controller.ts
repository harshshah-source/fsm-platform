import { BadRequestException, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentScope } from '../common/decorators/current-scope.decorator';
import type { ManagerScope } from '../common/manager-scope';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import {
  CommissioningAggregationService,
  type CommissioningCohortReport,
  type CommissioningPopulation,
  type InstallQualityGroupBy,
  type InstallQualityReport,
  type InstallQualitySort,
} from './commissioning-aggregation.service';
import { COHORT_DAYS, GRACE_HOURS, LOOKBACK_DAYS } from './commissioning.config';
import { FleetUptimeAggregationService, type FleetUptimeAggregationResult } from './fleet-uptime-aggregation.service';
import { type DistributionFilters, type FleetUptimeGroupBy, type FleetUptimeReport, type RootCauseReport, type SoftInactiveTrend, type SystemEfficiencyReport, type VerificationOutcomesReport, type WorkTypeMixReport, type ZmScorecardReport, ReportsService } from './reports.service';
import { type RootCauseAggregationResult, RootCauseAnalyticsAggregationService } from './root-cause-aggregation.service';
import { type SoftInactiveRecomputeResult, SoftInactiveCountService } from './soft-inactive-count.service';
import { type SystemEfficiencyAggregationResult, SystemEfficiencyAggregationService } from './system-efficiency-aggregation.service';
import { type ZmPerformanceAggregationResult, ZmPerformanceAggregationService } from './zm-performance-aggregation.service';

const MANAGER_ROLES = ['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'] as const;
const GROUP_BYS: FleetUptimeGroupBy[] = ['zone', 'company', 'plant'];

/**
 * `/api/reports/*` read surface (Issue 39). The Fleet Uptime % monthly report, scoped to the manager
 * roles (a ZM is filtered to their own zone in the service). The aggregation worker is exposed as an
 * Operations-Head recompute trigger until a month-end BullMQ cron lands.
 */
@Controller('reports')
@UseGuards(AuthGuard, RoleGuard)
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly aggregation: FleetUptimeAggregationService,
    private readonly softInactive: SoftInactiveCountService,
    private readonly rootCauseAggregation: RootCauseAnalyticsAggregationService,
    private readonly zmPerformance: ZmPerformanceAggregationService,
    private readonly systemEfficiency: SystemEfficiencyAggregationService,
    private readonly commissioning: CommissioningAggregationService,
  ) {}

  /**
   * Live commissioning cohort — fitments inside `cohortDays`, split online / pending / failed with the
   * per-plant and per-installer breakdowns. Manager roles; a ZM is clamped to their own zone in the
   * service and told so via `scopedToZoneId`.
   *
   * `population` defaults to `operational` (#233): warehouse devices are silent because they are in a
   * box, and counting them as failed installs put the live 90-day failure rate at 39.1% against an
   * actual 5.6%. `population=all` reproduces the pre-#233 figures for reconciliation.
   */
  @Get('commissioning/cohort')
  @Roles(...MANAGER_ROLES)
  commissioningCohort(
    @CurrentScope() scope: ManagerScope,
    @Query('cohortDays') cohortDays?: string,
    @Query('graceHours') graceHours?: string,
    @Query('population') population?: string,
    @Query('zoneId') zoneId?: string,
    @Query('plantId') plantId?: string,
    @Query('remark') remark?: string | string[],
  ): Promise<CommissioningCohortReport> {
    return this.commissioning.cohort(
      scope,
      {
        cohortDays: parseBoundedInt(cohortDays, 'cohortDays', COHORT_DAYS),
        graceHours: parseBoundedInt(graceHours, 'graceHours', GRACE_HOURS),
        population: parseEnum(population, 'population', POPULATIONS, 'operational'),
        zoneId: parseOptBigInt(zoneId, 'zoneId'),
        plantId: parseOptBigInt(plantId, 'plantId'),
        remarks: parseRemarks(remark),
      },
    );
  }

  /** Install quality over a longer lookback — the historical installer / plant breakdown. */
  @Get('commissioning/installers')
  @Roles(...MANAGER_ROLES)
  commissioningInstallers(
    @CurrentScope() scope: ManagerScope,
    @Query('lookbackDays') lookbackDays?: string,
    @Query('groupBy') groupBy?: string,
    @Query('sort') sort?: string,
    @Query('minInstalls') minInstalls?: string,
    @Query('population') population?: string,
    @Query('zoneId') zoneId?: string,
    @Query('plantId') plantId?: string,
    @Query('remark') remark?: string | string[],
  ): Promise<InstallQualityReport> {
    return this.commissioning.installQuality(
      scope,
      {
        lookbackDays: parseBoundedInt(lookbackDays, 'lookbackDays', LOOKBACK_DAYS),
        groupBy: parseEnum(groupBy, 'groupBy', INSTALL_QUALITY_GROUP_BYS, 'installer'),
        sort: parseEnum(sort, 'sort', INSTALL_QUALITY_SORTS, 'installs'),
        minInstalls: parseBoundedInt(minInstalls, 'minInstalls', MIN_INSTALLS),
        population: parseEnum(population, 'population', POPULATIONS, 'operational'),
        zoneId: parseOptBigInt(zoneId, 'zoneId'),
        plantId: parseOptBigInt(plantId, 'plantId'),
        remarks: parseRemarks(remark),
      },
    );
  }

  @Get('fleet-uptime')
  @Roles(...MANAGER_ROLES)
  fleetUptime(
    @CurrentScope() scope: ManagerScope,
    @Query('month') month?: string,
    @Query('groupBy') groupBy?: string,
  ): Promise<FleetUptimeReport> {
    // Acting-aware (Issue 27): this is the Fleet Uptime hero KPI on the dashboard, so a CSM / OH
    // acting in a zone must get that zone's uptime, not the pan-India figure under a zone heading.
    return this.reports.fleetUptime(scope, {
      month: month ?? currentMonth(),
      groupBy: parseGroupBy(groupBy),
    });
  }

  /** Recompute a month's summary on demand (Operations Head). Also cron-driven by
   *  `business-fleet-uptime` since #108 — this is the manual trigger, not the only path (#229 §4). */
  @Post('fleet-uptime/recompute')
  @HttpCode(200)
  @Roles('OPERATIONS_HEAD')
  recompute(@Query('month') month?: string): Promise<FleetUptimeAggregationResult> {
    return this.aggregation.computeMonth(monthToDate(month ?? currentMonth()));
  }

  /** Soft Inactive Count trend — per-zone twice-daily series for the last `days` (Operations Head, AC#3). */
  @Get('soft-inactive-trend')
  @Roles('OPERATIONS_HEAD')
  softInactiveTrend(@Query('days') days?: string): Promise<SoftInactiveTrend> {
    const parsed = days !== undefined && /^\d+$/.test(days) ? Number(days) : undefined;
    return this.reports.softInactiveTrend({ days: parsed });
  }

  /** Snapshot the Soft Inactive Count for every zone now (a twice-daily capture; Operations Head). */
  @Post('soft-inactive/recompute')
  @HttpCode(200)
  @Roles('OPERATIONS_HEAD')
  recomputeSoftInactive(): Promise<SoftInactiveRecomputeResult> {
    return this.softInactive.recompute();
  }

  /** Root Cause Analytics — % distribution over `root_cause_summary_monthly`, ZM zone-scoped (Issue 41). */
  @Get('root-cause')
  @Roles(...MANAGER_ROLES)
  rootCause(
    @CurrentScope() scope: ManagerScope,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('zoneId') zoneId?: string,
    @Query('companyId') companyId?: string,
    @Query('plantId') plantId?: string,
    @Query('deviceType') deviceType?: string,
    @Query('seId') seId?: string,
  ): Promise<RootCauseReport> {
    return this.reports.rootCause(
      scope,
      {
        fromMonth: from,
        toMonth: to,
        zoneId: parseOptInt(zoneId, 'zoneId'),
        companyId: parseOptInt(companyId, 'companyId'),
        plantId: parseOptInt(plantId, 'plantId'),
        deviceType,
        seId,
      },
    );
  }

  /** Recompute a month's root-cause summary on demand (Operations Head). Cron-wired at month-end later. */
  @Post('root-cause/recompute')
  @HttpCode(200)
  @Roles('OPERATIONS_HEAD')
  recomputeRootCause(@Query('month') month?: string): Promise<RootCauseAggregationResult> {
    return this.rootCauseAggregation.computeMonth(monthToDate(month ?? currentMonth()));
  }

  /**
   * ZM Performance Scorecard — ZM-wise comparison, zone drill-down, monthly trend (Issue 43). Gated to
   * OPERATIONS_HEAD only: never shown to the ZM, and not to CSM/SE.
   */
  @Get('zm-scorecard')
  @Roles('OPERATIONS_HEAD')
  zmScorecard(@Query('from') from?: string, @Query('to') to?: string, @Query('zoneId') zoneId?: string): Promise<ZmScorecardReport> {
    return this.reports.zmScorecard({ fromMonth: from, toMonth: to, zoneId: parseOptInt(zoneId, 'zoneId') });
  }

  /** Recompute a month's ZM scorecard on demand (Operations Head). Cron-wired at month-end later. */
  @Post('zm-scorecard/recompute')
  @HttpCode(200)
  @Roles('OPERATIONS_HEAD')
  recomputeZmScorecard(@Query('month') month?: string): Promise<ZmPerformanceAggregationResult> {
    return this.zmPerformance.computeMonth(monthToDate(month ?? currentMonth()));
  }

  /**
   * System Efficiency Report — end-to-end pipeline metrics over a day range from
   * `system_efficiency_summary_daily`, ZM zone-scoped, filterable by zone/company/plant/device-type/SE.
   */
  @Get('efficiency')
  @Roles(...MANAGER_ROLES)
  systemEfficiencyReport(
    @CurrentScope() scope: ManagerScope,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('zoneId') zoneId?: string,
    @Query('companyId') companyId?: string,
    @Query('plantId') plantId?: string,
    @Query('deviceType') deviceType?: string,
    @Query('seId') seId?: string,
  ): Promise<SystemEfficiencyReport> {
    return this.reports.systemEfficiency(
      scope,
      {
        from,
        to,
        zoneId: parseOptInt(zoneId, 'zoneId'),
        companyId: parseOptInt(companyId, 'companyId'),
        plantId: parseOptInt(plantId, 'plantId'),
        deviceType,
        seId,
      },
    );
  }

  /** Work-type mix — ticket counts per work type over a day range (Issue 90; ZM zone-scoped). */
  @Get('work-type-mix')
  @Roles(...MANAGER_ROLES)
  workTypeMix(
    @CurrentScope() scope: ManagerScope,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('zoneId') zoneId?: string,
    @Query('companyId') companyId?: string,
    @Query('plantId') plantId?: string,
  ): Promise<WorkTypeMixReport> {
    return this.reports.workTypeMix(scope, parseDistribution(from, to, zoneId, companyId, plantId));
  }

  /** Verification-outcome distribution over a day range (Issue 90; ZM zone-scoped). */
  @Get('verification-outcomes')
  @Roles(...MANAGER_ROLES)
  verificationOutcomes(
    @CurrentScope() scope: ManagerScope,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('zoneId') zoneId?: string,
    @Query('companyId') companyId?: string,
    @Query('plantId') plantId?: string,
  ): Promise<VerificationOutcomesReport> {
    return this.reports.verificationOutcomes(scope, parseDistribution(from, to, zoneId, companyId, plantId));
  }

  /** Recompute a day's efficiency summary on demand (Operations Head). Also cron-driven daily by
   *  `business-system-efficiency` since #108 — this is the manual trigger, not the only path (#229 §4). */
  @Post('efficiency/recompute')
  @HttpCode(200)
  @Roles('OPERATIONS_HEAD')
  recomputeEfficiency(@Query('day') day?: string): Promise<SystemEfficiencyAggregationResult> {
    return this.systemEfficiency.computeDay(dayToDate(day ?? currentDay()));
  }
}

const INSTALL_QUALITY_GROUP_BYS: InstallQualityGroupBy[] = ['installer', 'plant'];
const INSTALL_QUALITY_SORTS: InstallQualitySort[] = ['installs', 'neverOnlineRate'];
/** Order matters only for the error message; `operational` is the default at both call sites (#233). */
const POPULATIONS: CommissioningPopulation[] = ['operational', 'all'];
/** No ceiling worth enforcing — a high floor only ever shrinks the result set. */
const MIN_INSTALLS = { min: 1, max: 100_000, fallback: 1 } as const;

/**
 * Parse a bounded integer window param. The ceiling is a performance contract, not taste — an
 * unbounded lookback is the one query shape that abandons the `installed_at` index and spills its
 * GROUP BY to disk (see `commissioning.config.ts` for the measurements). Rejecting out-of-range input
 * at the edge is what keeps that plan unreachable, so this throws rather than clamping silently.
 */
function parseBoundedInt(raw: string | undefined, field: string, bounds: { min: number; max: number; fallback: number }): number {
  if (raw === undefined || raw === '') return bounds.fallback;
  if (!/^\d+$/.test(raw)) throw new BadRequestException({ code: 'INVALID_WINDOW', hint: `${field} must be a positive integer` });
  const value = Number(raw);
  if (value < bounds.min || value > bounds.max) {
    throw new BadRequestException({ code: 'WINDOW_OUT_OF_RANGE', hint: `${field} must be between ${bounds.min} and ${bounds.max}` });
  }
  return value;
}

/** Parse an optional bigint id query param, rejecting non-numeric input. */
function parseOptBigInt(raw: string | undefined, field: string): bigint | null {
  const parsed = parseOptInt(raw, field);
  return parsed === undefined ? null : BigInt(parsed);
}

function parseEnum<T extends string>(raw: string | undefined, field: string, allowed: T[], fallback: T): T {
  if (raw === undefined || raw === '') return fallback;
  if (!allowed.includes(raw as T)) throw new BadRequestException({ code: 'INVALID_FILTER', hint: `${field} must be one of ${allowed.join(' | ')}` });
  return raw as T;
}

/** `?remark=` is repeatable; Express hands over a string for one and an array for several. */
function parseRemarks(raw: string | string[] | undefined): string[] | null {
  if (raw === undefined) return null;
  const values = (Array.isArray(raw) ? raw : [raw]).map((v) => v.trim()).filter((v) => v !== '');
  return values.length > 0 ? values : null;
}

/** Shared query parsing for the two Issue-90 distribution endpoints. */
function parseDistribution(from?: string, to?: string, zoneId?: string, companyId?: string, plantId?: string): DistributionFilters {
  return {
    from,
    to,
    zoneId: parseOptInt(zoneId, 'zoneId'),
    companyId: parseOptInt(companyId, 'companyId'),
    plantId: parseOptInt(plantId, 'plantId'),
  };
}

/** Parse an optional integer query param, rejecting non-numeric input. */
function parseOptInt(raw: string | undefined, field: string): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (!/^\d+$/.test(raw)) throw new BadRequestException({ code: 'INVALID_FILTER', hint: `${field} must be an integer` });
  return Number(raw);
}

function parseGroupBy(raw: string | undefined): FleetUptimeGroupBy {
  if (raw === undefined) return 'zone';
  if (!GROUP_BYS.includes(raw as FleetUptimeGroupBy)) {
    throw new BadRequestException({ code: 'INVALID_GROUP_BY', hint: 'zone | company | plant' });
  }
  return raw as FleetUptimeGroupBy;
}

function monthToDate(month: string): Date {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new BadRequestException({ code: 'INVALID_MONTH', hint: 'expected YYYY-MM' });
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
}

function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function dayToDate(day: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new BadRequestException({ code: 'INVALID_DAY', hint: 'expected YYYY-MM-DD' });
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function currentDay(): string {
  return new Date().toISOString().slice(0, 10);
}
