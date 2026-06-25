import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { CurrentActor } from '../common/decorators/current-actor.decorator';
import type { RequestActor } from '../common/request-actor';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { ZonesService, type ZoneView } from './zones.service';

/**
 * Operations-Head-owned zone reference data (`/api/org/zones`). Separate from the zone-scoped
 * dashboard read (`/zones/:zoneId`, ZoneScopeGuard) — this is org configuration, role-gated.
 */
@Controller('org/zones')
@UseGuards(AuthGuard, RoleGuard)
@Roles('OPERATIONS_HEAD')
export class ZonesAdminController {
  constructor(private readonly zones: ZonesService) {}

  @Get()
  list(): Promise<ZoneView[]> {
    return this.zones.list();
  }

  @Post()
  create(
    @Body() body: { name: string },
    @CurrentActor() actor: RequestActor,
  ): Promise<ZoneView> {
    return this.zones.create(body.name, actor);
  }
}
