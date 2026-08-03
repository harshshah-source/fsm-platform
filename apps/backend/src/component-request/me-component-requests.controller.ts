import { Controller, Get, UseGuards } from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { ComponentRequestRow, ComponentRequestService } from './component-request.service';

/** `GET /api/me/component-requests` (#163 item 5) — the SE-readable variant of the manager-only
 *  oversight read (`GET /component-requests`). The SE `confirm-receipt`s a request but currently has
 *  no way to read it first, or to see what's driving the Inventory screen's "Active" list. */
@Controller('me/component-requests')
@UseGuards(AuthGuard, RoleGuard)
export class MeComponentRequestsController {
  constructor(private readonly requests: ComponentRequestService) {}

  @Get()
  @Roles('SERVICE_ENGINEER')
  async list(@CurrentUser() user: AccessTokenClaims): Promise<{ items: ComponentRequestRow[]; cursor: null }> {
    const items = await this.requests.bySe(user.user_id);
    return { items, cursor: null };
  }
}
