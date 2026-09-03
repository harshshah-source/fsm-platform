import {
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentActor } from '../common/decorators/current-actor.decorator';
import { CurrentScope } from '../common/decorators/current-scope.decorator';
import type { ManagerScope } from '../common/manager-scope';
import type { RequestActor } from '../common/request-actor';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { AutoRecoveryService } from './auto-recovery.service';
import { SpecialTicketQueryService, type SpecialAttemptHistory } from './special-ticket.query';
import {
  TicketQueryService,
  type TicketDetailView,
  type TicketFormView,
  type TicketView,
} from './ticket-query.service';

/**
 * The `/api/tickets/*` manager read surface (Issue 05 AC#6 + Issue 07). Scoped to the manager roles —
 * SEs read their work through the Day Plan / Shared Pool (Issues 11/12). A ZM is filtered to their own
 * zone (list and detail); CSM / Operations Head see all zones. Default order is SLA bucket descending.
 */
@Controller('tickets')
@UseGuards(AuthGuard, RoleGuard)
export class TicketsController {
  constructor(
    private readonly query: TicketQueryService,
    private readonly autoRecovery: AutoRecoveryService,
    private readonly special: SpecialTicketQueryService,
  ) {}

  @Get()
  @Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD')
  list(
    @CurrentScope() scope: ManagerScope,
    @Query('status') status?: string,
    @Query('workType') workType?: string,
    @Query('companyId') companyId?: string,
    @Query('plantId') plantId?: string,
    @Query('plant') plant?: string,
    @Query('q') q?: string,
    @Query('assignmentState') assignmentState?: string,
    @Query('bucket') bucket?: string,
    @Query('special') special?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<TicketView[]> {
    return this.query.list(
      scope,
      {
        status,
        workType,
        companyId,
        plantId,
        plant,
        q,
        assignmentState,
        bucket,
        special,
        limit: limit === undefined ? undefined : Number(limit),
        offset: offset === undefined ? undefined : Number(offset),
      },
    );
  }

  /**
   * #244 — the Special count for the caller's scope, plus the threshold it was judged against.
   *
   * **Declared before `:id` on purpose.** Nest matches routes in declaration order, so the literal
   * path has to come first or `:id` swallows it and the endpoint answers 404 "unknown ticket" — a
   * failure that looks exactly like a bad id and would be found in a browser rather than in CI. The
   * ordering is pinned by a test rather than left to this comment.
   */
  @Get('special-count')
  @Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD')
  specialCount(@CurrentScope() scope: ManagerScope): Promise<{ count: number; threshold: number }> {
    return this.query.countSpecial(scope);
  }

  @Get(':id')
  @Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD')
  async getOne(
    @CurrentScope() scope: ManagerScope,
    @Param('id') id: string,
  ): Promise<TicketDetailView> {
    const ticket = await this.query.getById(id, scope);
    if (!ticket) throw new NotFoundException({ code: 'TICKET_NOT_FOUND' });
    return ticket;
  }

  /** Per-ticket SE troubleshoot-form submissions (Issue 70; consumed by the FE-09 Forms tab). Manager
   *  read, zone-scoped like the detail read; 404 for an unknown / out-of-zone ticket. */
  @Get(':id/forms')
  @Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD')
  async forms(
    @CurrentScope() scope: ManagerScope,
    @Param('id') id: string,
  ): Promise<{ ticketId: string; forms: TicketFormView[] }> {
    const forms = await this.query.formsForTicket(id, scope);
    if (forms === null) throw new NotFoundException({ code: 'TICKET_NOT_FOUND' });
    return { ticketId: id, forms };
  }

  /**
   * #244 — the per-window attempt history behind a ticket's Special verdict.
   *
   * Scope and existence are enforced by reusing {@link TicketQueryService.getById}, exactly as
   * `:id/forms` does: an out-of-zone or unknown ticket yields 404 rather than 403, because a ZM is
   * not entitled to learn that a ticket in another zone exists.
   */
  @Get(':id/attempts')
  @Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD')
  async attempts(
    @CurrentScope() scope: ManagerScope,
    @Param('id') id: string,
  ): Promise<SpecialAttemptHistory> {
    const visible = await this.query.getById(id, scope);
    if (!visible) throw new NotFoundException({ code: 'TICKET_NOT_FOUND' });
    const history = await this.special.attemptsFor(id);
    if (!history) throw new NotFoundException({ code: 'TICKET_NOT_FOUND' });
    return history;
  }

  /** ZM/CSM/OpsHead manually marks an open Troubleshoot ticket CLOSED_AUTO_RECOVERY (Issue 08 AC#3). */
  @Post(':id/auto-recovery-close')
  @HttpCode(200)
  @Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD')
  async autoRecoveryClose(
    @CurrentScope() scope: ManagerScope,
    @CurrentActor() actor: RequestActor,
    @Param('id') id: string,
  ): Promise<{ status: string }> {
    // #341 — the reproduced case. A CSM acting in zone 2 used to close a zone-1 ticket for real,
    // because the scope came from their claims (pan-India for a CSM) while the banner said otherwise.
    const result = await this.autoRecovery.manualClose(id, scope, actor);
    if (result === 'NOT_FOUND') throw new NotFoundException({ code: 'TICKET_NOT_FOUND' });
    if (result === 'NOT_OPEN') throw new ConflictException({ code: 'TICKET_NOT_OPEN' });
    return { status: 'CLOSED_AUTO_RECOVERY' };
  }
}
