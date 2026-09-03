import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import {
  type DistrictView,
  GeographyService,
  type RegionView,
} from './geography.service';

const MANAGER_ROLES = ['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'] as const;

/**
 * Admin-geography reads for the territory selector (`/api/org/geo/...`, Issue 09).
 *
 * Manager-only (#362). This is reference data, not *public* reference data: the cascade enumerates
 * every state, region and district the business operates in, and the only screen that reads it is
 * the admin Territory page. Carrying `AuthGuard` alone meant any authenticated principal — a Service
 * Engineer's handset included — could page the whole national footprint out of it. The allow-list is
 * the three roles that can actually be handed a territory to manage; a Warehouse Manager works one
 * warehouse and has no territory selector to fill.
 */
@Controller('org/geo')
@UseGuards(AuthGuard, RoleGuard)
@Roles(...MANAGER_ROLES)
export class GeographyController {
  constructor(private readonly geography: GeographyService) {}

  @Get('states')
  states(): Promise<string[]> {
    return this.geography.listStates();
  }

  @Get('regions')
  regions(@Query('state') state?: string): Promise<RegionView[]> {
    return this.geography.listRegions(state);
  }

  @Get('districts')
  districts(
    @Query('state') state?: string,
    @Query('regionId') regionId?: string,
  ): Promise<DistrictView[]> {
    return this.geography.listDistricts(state, regionId === undefined ? undefined : Number(regionId));
  }
}
