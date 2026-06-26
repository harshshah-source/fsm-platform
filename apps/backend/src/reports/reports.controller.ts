import { BadRequestException, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { FleetUptimeAggregationService, type FleetUptimeAggregationResult } from './fleet-uptime-aggregation.service';
import { type FleetUptimeGroupBy, type FleetUptimeReport, type SoftInactiveTrend, ReportsService } from './reports.service';
import { type SoftInactiveRecomputeResult, SoftInactiveCountService } from './soft-inactive-count.service';

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
  ) {}

  @Get('fleet-uptime')
  @Roles(...MANAGER_ROLES)
  fleetUptime(
    @CurrentUser() user: AccessTokenClaims,
    @Query('month') month?: string,
    @Query('groupBy') groupBy?: string,
  ): Promise<FleetUptimeReport> {
    return this.reports.fleetUptime(
      { role: user.role, zoneId: user.zone_id },
      { month: month ?? currentMonth(), groupBy: parseGroupBy(groupBy) },
    );
  }

  /** Recompute a month's summary on demand (Operations Head). Cron-wired at month-end when scheduling lands. */
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
