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
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { AutoRecoveryService } from './auto-recovery.service';
import {
  TicketQueryService,
  type TicketDetailView,
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
  ) {}

  @Get()
  @Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD')
  list(
    @CurrentUser() user: AccessTokenClaims,
    @Query('status') status?: string,
    @Query('workType') workType?: string,
    @Query('companyId') companyId?: string,
    @Query('plantId') plantId?: string,
    @Query('assignmentState') assignmentState?: string,
    @Query('bucket') bucket?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<TicketView[]> {
    return this.query.list(
      { role: user.role, zoneId: user.zone_id },
      {
        status,
        workType,
        companyId,
        plantId,
        assignmentState,
        bucket,
        limit: limit === undefined ? undefined : Number(limit),
        offset: offset === undefined ? undefined : Number(offset),
      },
    );
  }

  @Get(':id')
  @Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD')
  async getOne(
    @CurrentUser() user: AccessTokenClaims,
    @Param('id') id: string,
  ): Promise<TicketDetailView> {
    const ticket = await this.query.getById(id, { role: user.role, zoneId: user.zone_id });
    if (!ticket) throw new NotFoundException({ code: 'TICKET_NOT_FOUND' });
    return ticket;
  }

  /** ZM/CSM/OpsHead manually marks an open Troubleshoot ticket CLOSED_AUTO_RECOVERY (Issue 08 AC#3). */
  @Post(':id/auto-recovery-close')
  @HttpCode(200)
  @Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD')
  async autoRecoveryClose(
    @CurrentUser() user: AccessTokenClaims,
    @Param('id') id: string,
  ): Promise<{ status: string }> {
    const result = await this.autoRecovery.manualClose(
      id,
      { role: user.role, zoneId: user.zone_id },
      { userId: user.user_id, role: user.role, actedAsRole: null },
    );
    if (result === 'NOT_FOUND') throw new NotFoundException({ code: 'TICKET_NOT_FOUND' });
    if (result === 'NOT_OPEN') throw new ConflictException({ code: 'TICKET_NOT_OPEN' });
    return { status: 'CLOSED_AUTO_RECOVERY' };
  }
}
