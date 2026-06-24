import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../common/guards/auth.guard';
import {
  type DistrictView,
  GeographyService,
  type RegionView,
} from './geography.service';

/** Admin-geography reads for the territory selector (`/api/org/geo/...`, Issue 09). Any
 * authenticated user may read this reference data. */
@Controller('org/geo')
@UseGuards(AuthGuard)
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
