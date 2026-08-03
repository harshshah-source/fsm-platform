import { Controller, Get, UseGuards } from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { MeTicketsQueryService, type MeTicketsView } from './me-tickets-query.service';

/**
 * The `/api/me/tickets` SE surface (#161, per #172 Decision 3). Merges the SE's day-plan (assigned)
 * and shared-pool (unassigned, covered-plant) work into one list. SE-only and read-only — scoped
 * server-side to the caller's own id, never an arbitrary se param (same convention as
 * `SharedPoolController`).
 */
@Controller('me')
@UseGuards(AuthGuard, RoleGuard)
export class MeTicketsController {
  constructor(private readonly tickets: MeTicketsQueryService) {}

  @Get('tickets')
  @Roles('SERVICE_ENGINEER')
  list(@CurrentUser() user: AccessTokenClaims): Promise<MeTicketsView> {
    return this.tickets.getMyTickets(user.user_id);
  }
}
