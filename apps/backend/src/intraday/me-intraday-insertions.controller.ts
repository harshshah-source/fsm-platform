import { Controller, Get, UseGuards } from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { IntradayInsertionRow, IntradayInsertionService } from './intraday-insertion.service';

/** `GET /api/me/intraday-insertions` (#163 item 3) — the SE's own currently-live offer(s), so the
 *  offer screen (with its acceptance countdown) is recoverable after an app restart. See
 *  `IntradayInsertionService.getMyPendingOffers`'s doc comment for the exact scope. */
@Controller('me/intraday-insertions')
@UseGuards(AuthGuard, RoleGuard)
export class MeIntradayInsertionsController {
  constructor(private readonly svc: IntradayInsertionService) {}

  @Get()
  @Roles('SERVICE_ENGINEER')
  async list(@CurrentUser() user: AccessTokenClaims): Promise<{ items: IntradayInsertionRow[]; cursor: null }> {
    const items = await this.svc.getMyPendingOffers(user.user_id);
    return { items, cursor: null };
  }
}
