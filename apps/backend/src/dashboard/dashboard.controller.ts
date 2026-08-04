import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import {
  DashboardService,
  type ActionRequiredCard,
  type ActivityTrendRange,
  type ActivityTrendReport,
  type CompanyPlantRow,
  type CriticalQueueGroup,
  type DeviceStatusScope,
  type FleetComposition,
  type FleetDirectory,
  type FleetSummary,
  type ZoneOperationsSummary,
  type ZoneOverviewRow,
} from './dashboard.service';

const ACTIVITY_TREND_RANGES: ActivityTrendRange[] = ['1D', '7D', '1M', '1Y', 'MAX'];
const DEVICE_STATUS_SCOPES: DeviceStatusScope[] = ['ALL', 'INACTIVE', 'ACTIVE'];

/**
 * The `/api/dashboard/*` manager read surface (Issue 06). Scoped to the manager roles; a ZM is
 * filtered to their own zone inside the service, CSM / Operations Head see all zones.
 */
@Controller('dashboard')
@UseGuards(AuthGuard, RoleGuard)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('zone-overview')
  @Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD')
  zoneOverview(@CurrentUser() user: AccessTokenClaims): Promise<ZoneOverviewRow[]> {
    return this.dashboard.zoneOverview({ role: user.role, zoneId: user.zone_id });
  }

  @Get('company-plant-overview')
  @Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD')
  companyPlantOverview(
    @CurrentUser() user: AccessTokenClaims,
    @Query('companyId') companyId?: string,
    @Query('plantId') plantId?: string,
    @Query('zoneId') zoneId?: string,
  ): Promise<CompanyPlantRow[]> {
    return this.dashboard.companyPlantOverview(
      { role: user.role, zoneId: user.zone_id },
      { companyId, plantId, zoneId },
    );
  }

  /**
   * How one zone's currently-open work is held — assigned vs not, over how many live batches and SEs.
   * Backs the `/reports/device` zone drill-down's assignment band; scoped by the same `zoneId` +
   * `status` the page reads off its query string. A ZM is clamped to their own zone in the service.
   */
  @Get('zone-operations')
  @Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD')
  zoneOperations(
    @CurrentUser() user: AccessTokenClaims,
    @Query('zoneId') zoneId?: string,
    @Query('status') status?: string,
  ): Promise<ZoneOperationsSummary> {
    return this.dashboard.zoneOperations(
      { role: user.role, zoneId: user.zone_id },
      { zoneId, status: parseStatusScope(status) },
    );
  }

  @Get('critical-queue')
  @Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD')
  criticalQueue(@CurrentUser() user: AccessTokenClaims): Promise<CriticalQueueGroup[]> {
    return this.dashboard.criticalQueue({ role: user.role, zoneId: user.zone_id });
  }

  @Get('action-required')
  @Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD')
  actionRequired(@CurrentUser() user: AccessTokenClaims): Promise<ActionRequiredCard[]> {
    return this.dashboard.actionRequired({ role: user.role, zoneId: user.zone_id });
  }

  /**
   * The Fleet Composition funnel: AutoPlant catalog → mirrored → operational → healthy/inactive, with
   * every drop between steps named and counted. A ZM's funnel is zone-scoped and omits the catalog
   * steps (the source counter has no zone attribution).
   */
  @Get('fleet-composition')
  @Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD')
  fleetComposition(@CurrentUser() user: AccessTokenClaims): Promise<FleetComposition> {
    return this.dashboard.fleetComposition({ role: user.role, zoneId: user.zone_id });
  }

  /** Headline fleet counts for the KPI strip: companies / plants / operational breakdown in scope. */
  @Get('fleet-summary')
  @Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD')
  fleetSummary(@CurrentUser() user: AccessTokenClaims): Promise<FleetSummary> {
    return this.dashboard.fleetSummary({ role: user.role, zoneId: user.zone_id });
  }

  /** The Companies/Plants KPI click-through (Issue 122b): every company + plant in scope, by name. */
  @Get('fleet-directory')
  @Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD')
  fleetDirectory(@CurrentUser() user: AccessTokenClaims): Promise<FleetDirectory> {
    return this.dashboard.fleetDirectory({ role: user.role, zoneId: user.zone_id });
  }

  /**
   * Fleet-activity trend (Issue 134): Inactive-device stock vs TROUBLESHOOT vs INSTALL over time.
   * `range` ∈ 1D|7D|1M|1Y|MAX (default 7D). A ZM is clamped to their own zone; an OH/CSM may pass
   * `zoneId` (zone-wise) or omit it (pan-India).
   */
  @Get('activity-trend')
  @Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD')
  activityTrend(
    @CurrentUser() user: AccessTokenClaims,
    @Query('range') range?: string,
    @Query('zoneId') zoneId?: string,
  ): Promise<ActivityTrendReport> {
    return this.dashboard.activityTrend(
      { role: user.role, zoneId: user.zone_id },
      { range: parseRange(range), zoneId: parseOptZoneId(zoneId) },
    );
  }
}

function parseRange(raw: string | undefined): ActivityTrendRange {
  if (raw === undefined || raw === '') return '7D';
  if (!ACTIVITY_TREND_RANGES.includes(raw as ActivityTrendRange)) {
    throw new BadRequestException({ code: 'INVALID_RANGE', hint: '1D | 7D | 1M | 1Y | MAX' });
  }
  return raw as ActivityTrendRange;
}

/** Unknown/absent reads as ALL — the drill-down's own default when the URL carries no `status`. */
function parseStatusScope(raw: string | undefined): DeviceStatusScope {
  return DEVICE_STATUS_SCOPES.includes(raw as DeviceStatusScope) ? (raw as DeviceStatusScope) : 'ALL';
}

function parseOptZoneId(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  if (!/^\d+$/.test(raw)) throw new BadRequestException({ code: 'INVALID_FILTER', hint: 'zoneId must be an integer' });
  return Number(raw);
}
