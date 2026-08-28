import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentScope } from '../common/decorators/current-scope.decorator';
import type { ManagerScope } from '../common/manager-scope';
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
const DEVICE_STATUS_SCOPES: DeviceStatusScope[] = ['ALL', 'INACTIVE', 'ACTIVE', 'NEVER_REPORTED'];

/**
 * The `/api/dashboard/*` manager read surface (Issue 06). Scoped to the manager roles; a ZM is
 * filtered to their own zone inside the service, CSM / Operations Head see all zones.
 *
 * Every read takes its scope from `@CurrentScope()`, which folds in the `X-Acting-As-Zone` header
 * (Issue 27): a CSM / Operations Head acting in a zone reads that zone only, exactly as its ZM would.
 * Using the raw claims here is what made "Act as ZM" cosmetic — the Zone Operations view rendered over
 * pan-India numbers.
 */
@Controller('dashboard')
@UseGuards(AuthGuard, RoleGuard)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('zone-overview')
  @Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD')
  zoneOverview(@CurrentScope() scope: ManagerScope): Promise<ZoneOverviewRow[]> {
    return this.dashboard.zoneOverview(scope);
  }

  @Get('company-plant-overview')
  @Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD')
  companyPlantOverview(
    @CurrentScope() scope: ManagerScope,
    @Query('companyId') companyId?: string,
    @Query('plantId') plantId?: string,
    @Query('zoneId') zoneId?: string,
  ): Promise<CompanyPlantRow[]> {
    return this.dashboard.companyPlantOverview(scope, { companyId, plantId, zoneId });
  }

  /**
   * How one zone's currently-open work is held — assigned vs not, over how many live batches and SEs.
   * Backs the `/reports/device` zone drill-down's assignment band; scoped by the same `zoneId` +
   * `status` the page reads off its query string. A ZM is clamped to their own zone in the service.
   */
  @Get('zone-operations')
  @Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD')
  zoneOperations(
    @CurrentScope() scope: ManagerScope,
    @Query('zoneId') zoneId?: string,
    @Query('status') status?: string,
  ): Promise<ZoneOperationsSummary> {
    return this.dashboard.zoneOperations(scope, { zoneId, status: parseStatusScope(status) });
  }

  @Get('critical-queue')
  @Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD')
  criticalQueue(@CurrentScope() scope: ManagerScope): Promise<CriticalQueueGroup[]> {
    return this.dashboard.criticalQueue(scope);
  }

  /**
   * **B5 — `?zoneId=` is a correctness fix, not a filter.**
   *
   * These counts are zone-scoped for a ZM and **global for a CSM / Operations Head**, which was right
   * while this only ever rendered on a dashboard that was itself pan-India for those roles. The
   * Scheduler Console renders the same cards beside a deck that is always **one zone**, and two panes
   * on one screen disagreeing about how much trouble a zone is in is a defect, not a preference — a
   * CSM would read "14 failed verifications" next to a North Zone board and act on a national number.
   *
   * Follows `zone-operations` exactly: a ZM is still clamped server-side and the parameter cannot widen
   * them; it only narrows a role that would otherwise see everything.
   */
  @Get('action-required')
  @Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD')
  actionRequired(
    @CurrentScope() scope: ManagerScope,
    @Query('zoneId') zoneId?: string,
  ): Promise<ActionRequiredCard[]> {
    return this.dashboard.actionRequired(scope, { zoneId });
  }

  /**
   * The Fleet Composition funnel: AutoPlant catalog → mirrored → operational → healthy/inactive, with
   * every drop between steps named and counted. A ZM's funnel is zone-scoped and omits the catalog
   * steps (the source counter has no zone attribution).
   */
  @Get('fleet-composition')
  @Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD')
  fleetComposition(@CurrentScope() scope: ManagerScope): Promise<FleetComposition> {
    return this.dashboard.fleetComposition(scope);
  }

  /** Headline fleet counts for the KPI strip: companies / plants / operational breakdown in scope. */
  @Get('fleet-summary')
  @Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD')
  fleetSummary(@CurrentScope() scope: ManagerScope): Promise<FleetSummary> {
    return this.dashboard.fleetSummary(scope);
  }

  /** The Companies/Plants KPI click-through (Issue 122b): every company + plant in scope, by name. */
  @Get('fleet-directory')
  @Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD')
  fleetDirectory(@CurrentScope() scope: ManagerScope): Promise<FleetDirectory> {
    return this.dashboard.fleetDirectory(scope);
  }

  /**
   * Fleet-activity trend (Issue 134): Inactive-device stock vs TROUBLESHOOT vs INSTALL over time.
   * `range` ∈ 1D|7D|1M|1Y|MAX (default 7D). A ZM is clamped to their own zone; an OH/CSM may pass
   * `zoneId` (zone-wise) or omit it (pan-India).
   */
  @Get('activity-trend')
  @Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD')
  activityTrend(
    @CurrentScope() scope: ManagerScope,
    @Query('range') range?: string,
    @Query('zoneId') zoneId?: string,
  ): Promise<ActivityTrendReport> {
    return this.dashboard.activityTrend(scope, {
      range: parseRange(range),
      zoneId: parseOptZoneId(zoneId),
    });
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
