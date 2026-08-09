import { Controller, Get, NotFoundException, Param, Query, UseGuards } from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { MeTicketDetailService, type MeTicketDetailView } from './me-ticket-detail.service';
import { MeTicketFormsService } from './me-ticket-forms.service';
import { MeTicketsQueryService, type MeTicketsView } from './me-tickets-query.service';
import { MeWorkHistoryService, type MeWorkHistoryView } from './me-work-history.service';
import type { TicketFormView } from '../ticketing/ticket-query.service';

/**
 * The `/api/me/tickets*` SE surface. `GET /me/tickets` (#161 item 2, per #172 Decision 3) merges the
 * SE's day-plan (assigned) and shared-pool (unassigned, covered-plant) work into one list.
 * `GET /me/tickets/:id` (#161 item 1) expands one ticket into the mobile Ticket Detail payload —
 * covers TROUBLESHOOT/RECOVERY/INSTALL uniformly (see `MeTicketDetailService`).
 * `GET /me/tickets/:id/forms` (#161 item 3) is the SE-readable variant of the manager-only
 * `GET /tickets/:id/forms`, scoped to the caller's own submissions (see `MeTicketFormsService`).
 * `GET /me/work-history` (#175) is the per-day assigned/completed series behind Home's chart.
 * All SE-only and read-only — scoped server-side to the caller's own id, never an arbitrary se param
 * (same convention as `SharedPoolController`).
 */
@Controller('me')
@UseGuards(AuthGuard, RoleGuard)
export class MeTicketsController {
  constructor(
    private readonly tickets: MeTicketsQueryService,
    private readonly ticketDetail: MeTicketDetailService,
    private readonly ticketForms: MeTicketFormsService,
    private readonly workHistory: MeWorkHistoryService,
  ) {}

  @Get('tickets')
  @Roles('SERVICE_ENGINEER')
  list(@CurrentUser() user: AccessTokenClaims): Promise<MeTicketsView> {
    return this.tickets.getMyTickets(user.user_id);
  }

  /** #175 — the Home "Assigned vs Completed" series. `days` is bounded and sanitised by the service
   *  (a query value arrives as an unvalidated string), so a junk value renders a default chart rather
   *  than 400-ing a screen that is otherwise fine. */
  @Get('work-history')
  @Roles('SERVICE_ENGINEER')
  history(
    @CurrentUser() user: AccessTokenClaims,
    @Query('days') days?: string,
  ): Promise<MeWorkHistoryView> {
    return this.workHistory.getWorkHistory(user.user_id, { days: days == null ? undefined : Number(days) });
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

  /** Never distinguishes "unknown ticket" from "no own submissions and not otherwise readable" —
   *  see `MeTicketFormsService`'s access-gate doc for the full rule. */
  @Get('tickets/:id/forms')
  @Roles('SERVICE_ENGINEER')
  async forms(
    @CurrentUser() user: AccessTokenClaims,
    @Param('id') id: string,
  ): Promise<{ ticketId: string; forms: TicketFormView[] }> {
    const forms = await this.ticketForms.getMyForms(user.user_id, id);
    if (forms === null) throw new NotFoundException({ code: 'TICKET_NOT_FOUND' });
    return { ticketId: id, forms };
  }
}
