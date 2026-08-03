import { Controller, Get, NotFoundException, Param, UseGuards } from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { MeTicketDetailService, type MeTicketDetailView } from './me-ticket-detail.service';
import { MeTicketsQueryService, type MeTicketsView } from './me-tickets-query.service';

/**
 * The `/api/me/tickets*` SE surface. `GET /me/tickets` (#161 item 2, per #172 Decision 3) merges the
 * SE's day-plan (assigned) and shared-pool (unassigned, covered-plant) work into one list.
 * `GET /me/tickets/:id` (#161 item 1) expands one ticket into the mobile Ticket Detail payload —
 * covers TROUBLESHOOT/RECOVERY/INSTALL uniformly (see `MeTicketDetailService`). Both SE-only and
 * read-only — scoped server-side to the caller's own id, never an arbitrary se param (same
 * convention as `SharedPoolController`).
 */
@Controller('me')
@UseGuards(AuthGuard, RoleGuard)
export class MeTicketsController {
  constructor(
    private readonly tickets: MeTicketsQueryService,
    private readonly ticketDetail: MeTicketDetailService,
  ) {}

  @Get('tickets')
  @Roles('SERVICE_ENGINEER')
  list(@CurrentUser() user: AccessTokenClaims): Promise<MeTicketsView> {
    return this.tickets.getMyTickets(user.user_id);
  }

  /** Out-of-coverage / unknown / not-yet-visible-to-this-SE all 404 alike — never distinguished, so
   *  the response never confirms a ticket's existence to an SE with no legitimate reason to know. */
  @Get('tickets/:id')
  @Roles('SERVICE_ENGINEER')
  async detail(
    @CurrentUser() user: AccessTokenClaims,
    @Param('id') id: string,
  ): Promise<MeTicketDetailView> {
    const detail = await this.ticketDetail.getTicketDetail(user.user_id, id);
    if (!detail) throw new NotFoundException({ code: 'TICKET_NOT_FOUND' });
    return detail;
  }
}
