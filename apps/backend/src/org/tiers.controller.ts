import { Controller, Get, UseGuards } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { TiersService, type TierView } from './tiers.service';

/**
 * Canonical tier reference data (`/api/org/tiers`, Issue 157 AC-1) — the PRD-canon list + order
 * as data, replacing the hard-coded PLATINUM/GOLD/SILVER dropdown options.
 */
@Controller('org/tiers')
@UseGuards(AuthGuard, RoleGuard)
@Roles('OPERATIONS_HEAD')
export class TiersAdminController {
  constructor(private readonly tiers: TiersService) {}

  @Get()
  list(): Promise<TierView[]> {
    return this.tiers.list();
  }
}
