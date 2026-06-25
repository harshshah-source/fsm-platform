import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import {
  CompaniesService,
  type CompanyView,
  type CreateCompanyInput,
  type UpdateCompanyInput,
} from './companies.service';

/**
 * Operations-Head-owned company reference data (`/api/org/companies`). Tier + priority rank are
 * the recommender's top-level scoring gate / tie-break (schema D1); consumed by Issues 06/10.
 */
@Controller('org/companies')
@UseGuards(AuthGuard, RoleGuard)
@Roles('OPERATIONS_HEAD')
export class CompaniesAdminController {
  constructor(private readonly companies: CompaniesService) {}

  @Get()
  list(): Promise<CompanyView[]> {
    return this.companies.list();
  }

  @Post()
  create(
    @Body() body: CreateCompanyInput,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<CompanyView> {
    return this.companies.create(body, user);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: UpdateCompanyInput,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<CompanyView> {
    return this.companies.update(Number(id), body, user);
  }
}
