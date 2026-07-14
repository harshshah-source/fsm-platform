import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import {
  DashboardService,
  type ActionRequiredCard,
  type CompanyPlantRow,
  type CriticalQueueGroup,
  type FleetDirectory,
  type FleetSummary,
  type ZoneOverviewRow,
} from './dashboard.service';

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
  ): Promise<CompanyPlantRow[]> {
    return this.dashboard.companyPlantOverview(
      { role: user.role, zoneId: user.zone_id },
      { companyId, plantId },
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

  /** Headline fleet counts for the KPI strip (Issue 122b): companies / plants / devices in scope. */
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
}
