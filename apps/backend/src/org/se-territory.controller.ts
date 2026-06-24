import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import {
  type CreateTerritoryInput,
  SeTerritoryService,
  type TerritoryView,
} from './se-territory.service';

/** Operations-Head-owned Floating-SE Territory config (`/api/org/se-territory`, Issue 09). */
@Controller('org/se-territory')
@UseGuards(AuthGuard, RoleGuard)
@Roles('OPERATIONS_HEAD')
export class SeTerritoryAdminController {
  constructor(private readonly territory: SeTerritoryService) {}

  @Get()
  list(@Query('seId') seId?: string): Promise<TerritoryView[]> {
    return this.territory.listTerritory(seId);
  }

  @Post()
  add(
    @Body() body: CreateTerritoryInput,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<TerritoryView> {
    return this.territory.addTerritory(body, user);
  }

  @Delete(':id')
  remove(
    @Param('id') id: string,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<{ id: number }> {
    return this.territory.removeTerritory(Number(id), user);
  }
}
