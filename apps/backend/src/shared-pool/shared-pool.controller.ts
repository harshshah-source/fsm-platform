import { Controller, Get, UseGuards } from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { SharedPoolService, type SharedPoolTicket } from './shared-pool.service';

/**
 * The `/api/me/shared-pool` SE surface (Issue 12 AC#4/#5). Returns the authenticated SE's covered-
 * plant secondary work — scoped server-side to the caller's own id, never an arbitrary se param.
 * SE-only and read-only: there is no Reject or pick action on the pool.
 */
@Controller('me')
@UseGuards(AuthGuard, RoleGuard)
export class SharedPoolController {
  constructor(private readonly sharedPool: SharedPoolService) {}

  @Get('shared-pool')
  @Roles('SERVICE_ENGINEER')
  list(@CurrentUser() user: AccessTokenClaims): Promise<SharedPoolTicket[]> {
    return this.sharedPool.getSharedPool(user.user_id);
  }
}
