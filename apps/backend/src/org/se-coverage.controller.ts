import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import {
  type CreateEngineerInput,
  type CreateSeCoverageInput,
  type EngineerView,
  SeCoverageService,
  type SeCoverageView,
} from './se-coverage.service';

/** Operations-Head-owned SE profiles (`/api/org/engineers`). AC#2 — coverage types. */
@Controller('org/engineers')
@UseGuards(AuthGuard, RoleGuard)
@Roles('OPERATIONS_HEAD')
export class EngineersAdminController {
  constructor(private readonly seCoverage: SeCoverageService) {}

  @Get()
  list(): Promise<EngineerView[]> {
    return this.seCoverage.listEngineers();
  }

  @Post()
  create(
    @Body() body: CreateEngineerInput,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<EngineerView> {
    return this.seCoverage.createEngineer(body, user);
  }
}

/** Operations-Head-owned SE→plant coverage mappings (`/api/org/se-coverage`). AC#2 — SE mappings. */
@Controller('org/se-coverage')
@UseGuards(AuthGuard, RoleGuard)
@Roles('OPERATIONS_HEAD')
export class SeCoverageAdminController {
  constructor(private readonly seCoverage: SeCoverageService) {}

  @Get()
  list(@Query('seId') seId?: string): Promise<SeCoverageView[]> {
    return this.seCoverage.listCoverage(seId);
  }

  @Post()
  add(
    @Body() body: CreateSeCoverageInput,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<SeCoverageView> {
    return this.seCoverage.addCoverage(body, user);
  }

  @Delete(':id')
  remove(
    @Param('id') id: string,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<{ id: number }> {
    return this.seCoverage.removeCoverage(Number(id), user);
  }
}
