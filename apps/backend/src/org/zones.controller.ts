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

  /**
   * The zone list is read by both acting-capable roles, not just the configurator: the "Act as ZM"
   * control picks a zone from it (Issue 27), and a CSM can act. Zone names are already visible to a
   * CSM through the Zone Performance Scorecard, so this widens no data — only the write below stays
   * Operations-Head-only.
   */
  @Get()
  @Roles('CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD')
  list(): Promise<ZoneView[]> {
    return this.zones.list();
  }

  @Post()
  @Roles('OPERATIONS_HEAD')
  create(
    @Body() body: { name: string },
    @CurrentActor() actor: RequestActor,
  ): Promise<ZoneView> {
    return this.zones.create(body.name, actor);
  }
}
