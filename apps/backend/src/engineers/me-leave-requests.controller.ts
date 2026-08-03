import { Controller, Get, UseGuards } from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { LeaveRequestService, type LeaveRequestRow } from './leave-request.service';

/** `GET /api/me/leave-requests` (#163 item 2) — the SE-readable variant of the manager-only
 *  `GET /leave-requests`. Keyed on the caller's own `seId`, every status (not just PENDING) so a
 *  past rejection's `decisionReason` stays visible. */
@Controller('me/leave-requests')
@UseGuards(AuthGuard, RoleGuard)
export class MeLeaveRequestsController {
  constructor(private readonly leave: LeaveRequestService) {}

  @Get()
  @Roles('SERVICE_ENGINEER')
  async list(@CurrentUser() user: AccessTokenClaims): Promise<{ items: LeaveRequestRow[]; cursor: null }> {
    const items = await this.leave.listForSe(user.user_id);
    return { items, cursor: null };
  }
}
