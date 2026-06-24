import { ConflictException, Controller, Get, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { ComponentRequestService } from './component-request.service';

const MANAGER_ROLES = ['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'] as const;

/**
 * SE + ZM legs of the Component Request lifecycle (Issue 22, `/api/component-requests/:id`). The SE
 * confirms receipt of the shipped spare (→ RECEIVED); the Zonal Manager confirms the resubmit binding
 * (resumes SLA, reopens the cycle, applies resubmit ownership). The SE then resubmits the troubleshoot
 * form with a new `client_submission_id` via the existing `/api/tickets/:id/troubleshoot` route.
 */
@Controller('component-requests')
@UseGuards(AuthGuard, RoleGuard)
export class ComponentRequestController {
  constructor(private readonly requests: ComponentRequestService) {}

  /**
   * Manager read-only oversight (Issue 23). ZM sees own-zone requests; CSM / Operations Head see all
   * zones. Read-only — no approve/ship/reject is exposed here (the Warehouse Manager owns those).
   */
  @Get()
  @Roles(...MANAGER_ROLES)
  oversight(@CurrentUser() user: AccessTokenClaims) {
    return this.requests.oversightQueue({ role: user.role, zoneId: user.zone_id });
  }

  @Post(':id/confirm-receipt')
  @Roles('SERVICE_ENGINEER')
  async confirmReceipt(@CurrentUser() user: AccessTokenClaims, @Param('id') id: string) {
    const outcome = await this.requests.confirmReceipt(id, { userId: user.user_id, role: user.role });
    if (outcome.result === 'NOT_FOUND') throw new NotFoundException({ code: 'COMPONENT_REQUEST_NOT_FOUND' });
    if (outcome.result === 'INVALID_STATE') {
      throw new ConflictException({ code: 'COMPONENT_REQUEST_INVALID_STATE', status: outcome.status });
    }
    return { request: outcome.request };
  }

  @Post(':id/confirm-resubmit')
  @Roles(...MANAGER_ROLES)
  async confirmResubmit(@CurrentUser() user: AccessTokenClaims, @Param('id') id: string) {
    const outcome = await this.requests.confirmResubmit(id, { userId: user.user_id, role: user.role });
    if (outcome.result === 'NOT_FOUND') throw new NotFoundException({ code: 'COMPONENT_REQUEST_NOT_FOUND' });
    if (outcome.result === 'INVALID_STATE') {
      throw new ConflictException({ code: 'COMPONENT_REQUEST_INVALID_STATE', status: outcome.status });
    }
    return { request: outcome.request, ownership: outcome.ownership };
  }
}
