import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../common/guards/auth.guard';
import { ZoneScopeGuard } from '../common/guards/zone-scope.guard';

@Controller('zones')
@UseGuards(AuthGuard, ZoneScopeGuard)
export class ZonesController {
  @Get(':zoneId')
  getZone(@Param('zoneId') zoneId: string): { zoneId: number } {
    // Placeholder body — zone dashboard data arrives in later slices.
    return { zoneId: Number(zoneId) };
  }
}
