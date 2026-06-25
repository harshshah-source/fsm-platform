import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentActor } from '../common/decorators/current-actor.decorator';
import type { RequestActor } from '../common/request-actor';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { PlantsService, type PlantView } from './plants.service';

/** Operations-Head-owned plant reference data (`/api/org/plants`). */
@Controller('org/plants')
@UseGuards(AuthGuard, RoleGuard)
@Roles('OPERATIONS_HEAD')
export class PlantsAdminController {
  constructor(private readonly plants: PlantsService) {}

  @Get()
  list(@Query('zoneId') zoneId?: string): Promise<PlantView[]> {
    return this.plants.list(zoneId === undefined ? undefined : Number(zoneId));
  }

  @Post()
  create(
    @Body() body: { name: string; zoneId: number },
    @CurrentActor() actor: RequestActor,
  ): Promise<PlantView> {
    return this.plants.create(body.name, body.zoneId, actor);
  }
}
