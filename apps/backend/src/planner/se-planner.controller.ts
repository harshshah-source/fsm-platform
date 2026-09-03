import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentActor } from '../common/decorators/current-actor.decorator';
import { CurrentScope } from '../common/decorators/current-scope.decorator';
import type { ManagerScope } from '../common/manager-scope';
import type { RequestActor } from '../common/request-actor';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import {
  SePlannerService,
  type PlannerEntryView,
  type PlannerPlantView,
} from './se-planner.service';

const MANAGER_ROLES = ['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'] as const;

/**
 * The `/api/planner` SE Planner surface (Issue 14a). ZM-authored plant-visit intents, zone-scoped.
 * The grid UI (Issue 14b) drives these endpoints. Out-of-zone access for a ZM is 403.
 */
@Controller('planner')
@UseGuards(AuthGuard, RoleGuard)
export class SePlannerController {
  constructor(private readonly planner: SePlannerService) {}

  @Get()
  @Roles(...MANAGER_ROLES)
  list(
    @CurrentScope() scope: ManagerScope,
    @Query('dateFrom') dateFrom: string,
    @Query('dateTo') dateTo: string,
  ): Promise<PlannerEntryView[]> {
    return this.planner.list({ dateFrom, dateTo }, scope);
  }

  // Static route — distinct from the GET list (`''`); the grid's zone-scoped plant picker source.
  @Get('plants')
  @Roles(...MANAGER_ROLES)
  plants(@CurrentScope() scope: ManagerScope): Promise<PlannerPlantView[]> {
    return this.planner.listPlants(scope);
  }


          //new HttP methord (25th August )
  @Post()
  @Roles(...MANAGER_ROLES)
  async create(
    @CurrentScope() scope: ManagerScope,
    @CurrentActor() actor: RequestActor,
    @Body() body: { seId: string; plantId: string; plannedDate: string },
  ): Promise<PlannerEntryView> {
    const outcome = await this.planner.upsert(body, scope, actor);
    if (outcome.result === 'NOT_FOUND') throw new NotFoundException({ code: 'PLANT_NOT_FOUND' });
    if (outcome.result === 'OUT_OF_SCOPE') throw new ForbiddenException({ code: 'ZONE_SCOPE_VIOLATION' });
    return outcome.entry;
  }

  @Delete(':id')
  @Roles(...MANAGER_ROLES)
  async remove(
    @CurrentScope() scope: ManagerScope,
    @CurrentActor() actor: RequestActor,
    @Param('id') id: string,
  ): Promise<{ deleted: boolean }> {
    const outcome = await this.planner.remove(id, scope, actor);
    if (outcome.result === 'NOT_FOUND') throw new NotFoundException({ code: 'PLANNER_ENTRY_NOT_FOUND' });
    if (outcome.result === 'OUT_OF_SCOPE') throw new ForbiddenException({ code: 'ZONE_SCOPE_VIOLATION' });
    return { deleted: true };
  }
}
